"""WebSocket API handlers for RTSP Recorder.

This module contains all WebSocket endpoint handlers, extracted from __init__.py
to improve maintainability (HIGH-001 Fix from Audit Report v1.0.7).

All handlers are registered via `register_websocket_handlers()` function.
"""
import logging
import datetime
import asyncio
import aiohttp
import voluptuous as vol

from homeassistant.components import websocket_api

from .helpers import log_to_file, get_system_stats, get_inference_stats
from .const import DEFAULT_STORAGE_PATH, DEFAULT_SNAPSHOT_PATH, DOMAIN
from .face_matching import _normalize_embedding_simple, _cosine_similarity_simple
from .people_db import (
    _load_people_db, 
    _public_people_view, 
    get_ignored_embeddings,
    is_sqlite_enabled,
    _save_person_to_sqlite,
    _delete_person_from_sqlite,
    _add_embedding_to_sqlite,
    _rename_person_in_sqlite,
)
from .analysis_helpers import (
    _read_analysis_results,
    _find_analysis_for_video,
    _summarize_analysis,
)
from .analysis import detect_available_devices
from .services import get_batch_analysis_progress, get_single_analysis_progress, get_recording_progress, cancel_batch_analysis
from . import camera_settings as _cam
from .rate_limiter import limit

_LOGGER = logging.getLogger(__name__)


def register_websocket_handlers(
    hass,
    entry,
    config_data: dict,
    analysis_output_path: str,
    analysis_detector_url: str,
    analysis_face_match_threshold: float,
    analysis_perf_cpu_entity: str | None,
    analysis_perf_igpu_entity: str | None,
    analysis_perf_coral_entity: str | None,
) -> None:
    """Register all WebSocket handlers for the RTSP Recorder integration.
    
    Args:
        hass: Home Assistant instance
        entry: Config entry
        config_data: Merged config data (entry.data + entry.options)
        analysis_output_path: Path to analysis output directory
        analysis_detector_url: URL of the detector service
        analysis_face_match_threshold: Face matching threshold
        analysis_perf_cpu_entity: CPU performance sensor entity ID
        analysis_perf_igpu_entity: iGPU performance sensor entity ID
        analysis_perf_coral_entity: Coral performance sensor entity ID
    """
    
    # Get inference stats tracker
    _inference_stats = get_inference_stats()
    
    # Config values we need from config_data
    analysis_enabled = config_data.get("analysis_enabled", True)
    analysis_auto_enabled = config_data.get("analysis_auto_enabled", False)
    analysis_auto_mode = config_data.get("analysis_auto_mode", "daily")
    analysis_auto_time = config_data.get("analysis_auto_time", "03:00")
    analysis_auto_interval_hours = int(config_data.get("analysis_auto_interval_hours", 24))
    analysis_auto_since_days = int(config_data.get("analysis_auto_since_days", 3))
    analysis_auto_limit = int(config_data.get("analysis_auto_limit", 10))
    analysis_auto_skip_existing = bool(config_data.get("analysis_auto_skip_existing", True))
    analysis_auto_new = bool(config_data.get("analysis_auto_new", False))
    analysis_auto_force_coral = bool(config_data.get("analysis_auto_force_coral", False))
    analysis_device = config_data.get("analysis_device", "cpu")
    analysis_objects = config_data.get("analysis_objects", ["person"])
    analysis_face_enabled = bool(config_data.get("analysis_face_enabled", False))
    analysis_face_confidence = float(config_data.get("analysis_face_confidence", 0.5))
    analysis_face_store_embeddings = bool(config_data.get("analysis_face_store_embeddings", True))
    person_entities_enabled = bool(config_data.get("person_entities_enabled", False))
    # v1.1.0: Pfade für Frontend (v1.2.3: use constants for consistent defaults)
    storage_path = config_data.get("storage_path", DEFAULT_STORAGE_PATH)
    snapshot_path_base = config_data.get("snapshot_path", DEFAULT_SNAPSHOT_PATH)

    # Helper functions
    def _sensor_info(entity_id: str | None) -> dict | None:
        """Get sensor info for performance tracking."""
        if not entity_id:
            return None
        state = hass.states.get(entity_id)
        if not state:
            return {"entity_id": entity_id, "state": None, "unit": None, "name": None}
        return {
            "entity_id": entity_id,
            "state": state.state,
            "unit": state.attributes.get("unit_of_measurement"),
            "name": state.attributes.get("friendly_name", entity_id),
        }

    async def _fetch_remote_devices(url: str) -> list[str]:
        """Fetch available devices from detector service."""
        if not url:
            return []
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{url.rstrip('/')}/info", timeout=5) as resp:
                    if resp.status != 200:
                        return []
                    data = await resp.json()
                    return data.get("devices", [])
        except Exception:
            return []

    async def _fetch_detector_stats(url: str) -> dict:
        """Fetch stats from detector service."""
        if not url:
            return {"error": "no_detector_url"}
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{url.rstrip('/')}/stats", timeout=5) as resp:
                    if resp.status == 404:
                        async with session.get(f"{url.rstrip('/')}/info", timeout=5) as info_resp:
                            if info_resp.status == 200:
                                info = await info_resp.json()
                                return {
                                    "available": True,
                                    "devices": info.get("devices", []),
                                    "stats_supported": False,
                                }
                        return {"available": False, "error": "stats_not_supported"}
                    if resp.status != 200:
                        return {"available": False, "error": f"http_{resp.status}"}
                    data = await resp.json()
                    data["available"] = True
                    data["stats_supported"] = True
                    return data
        except asyncio.TimeoutError:
            return {"available": False, "error": "timeout"}
        except Exception as e:
            return {"available": False, "error": str(e)}

    # ===== WebSocket Handlers =====

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/get_analysis_overview",
        vol.Optional("limit", default=20): int,
        vol.Optional("page", default=1): int,
        vol.Optional("per_page", default=0): int,
    })
    @websocket_api.async_response
    async def ws_get_analysis_overview(hass, connection, msg):
        """Get analysis overview with stats and pagination support.
        
        If per_page > 0, uses pagination mode.
        Otherwise uses legacy limit mode for backward compatibility.
        """
        limit = msg.get("limit", 20)
        page = msg.get("page", 1)
        per_page = msg.get("per_page", 0)
        
        result = await hass.async_add_executor_job(
            _read_analysis_results, analysis_output_path, limit, page, per_page
        )
        
        items = result.get("items", [])
        stats = _summarize_analysis(items)
        
        devices = []
        if analysis_detector_url:
            devices = await _fetch_remote_devices(analysis_detector_url)
        if not devices:
            devices = await hass.async_add_executor_job(detect_available_devices)
        
        perf = {
            "cpu": _sensor_info(analysis_perf_cpu_entity),
            "igpu": _sensor_info(analysis_perf_igpu_entity),
            "coral": _sensor_info(analysis_perf_coral_entity),
        }
        
        # Return paginated response
        connection.send_result(msg["id"], {
            "items": items,
            "stats": stats,
            "perf": perf,
            "devices": devices,
            # Pagination info
            "total": result.get("total", len(items)),
            "page": result.get("page", 1),
            "per_page": result.get("per_page", limit),
            "total_pages": result.get("total_pages", 1),
        })

    websocket_api.async_register_command(hass, ws_get_analysis_overview)

    # ======== GET BATCH ANALYSIS PROGRESS ========
    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/get_analysis_progress",
    })
    @websocket_api.async_response
    async def ws_get_analysis_progress(hass, connection, msg):
        """Get current batch analysis progress."""
        try:
            progress = get_batch_analysis_progress()
            connection.send_result(msg["id"], progress)
        except Exception as e:
            log_to_file(f"Error getting analysis progress: {e}")
            connection.send_result(msg["id"], {
                "running": False,
                "total": 0,
                "current": 0,
                "current_file": "",
                "started_at": None,
            })

    websocket_api.async_register_command(hass, ws_get_analysis_progress)

    # ======== v1.2.3: STOP BATCH ANALYSIS ========
    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/stop_batch_analysis",
    })
    @websocket_api.async_response
    async def ws_stop_batch_analysis(hass, connection, msg):
        """Stop running batch analysis."""
        try:
            success = cancel_batch_analysis()
            connection.send_result(msg["id"], {
                "success": success,
                "message": "Batch analysis stop requested" if success else "No batch analysis running"
            })
        except Exception as e:
            log_to_file(f"Error stopping batch analysis: {e}")
            connection.send_result(msg["id"], {"success": False, "error": str(e)})

    websocket_api.async_register_command(hass, ws_stop_batch_analysis)

    # ======== GET SINGLE ANALYSIS PROGRESS ========
    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/get_single_analysis_progress",
    })
    @websocket_api.async_response
    async def ws_get_single_analysis_progress(hass, connection, msg):
        """Get current single video analysis progress."""
        try:
            progress = get_single_analysis_progress()
            connection.send_result(msg["id"], progress)
        except Exception as e:
            log_to_file(f"Error getting single analysis progress: {e}")
            connection.send_result(msg["id"], {
                "running": False,
                "media_id": "",
                "video_path": "",
                "started_at": None,
                "completed": False,
            })

    websocket_api.async_register_command(hass, ws_get_single_analysis_progress)

    # ======== GET RECORDING PROGRESS ========
    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/get_recording_progress",
    })
    @websocket_api.async_response
    async def ws_get_recording_progress(hass, connection, msg):
        """Get current recording progress."""
        try:
            progress = get_recording_progress()
            connection.send_result(msg["id"], progress)
        except Exception as e:
            log_to_file(f"Error getting recording progress: {e}")
            connection.send_result(msg["id"], {
                "running": False,
                "camera": "",
                "video_path": "",
                "duration": 0,
                "started_at": None,
            })

    websocket_api.async_register_command(hass, ws_get_recording_progress)

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/get_analysis_result",
        vol.Required("media_id"): str,
    })
    @websocket_api.async_response
    async def ws_get_analysis_result(hass, connection, msg):
        """Get analysis result for a specific video."""
        media_id = msg.get("media_id", "")
        if "local/" not in media_id:
            connection.send_result(msg["id"], {})
            return
        relative_path = media_id.split("local/", 1)[1]
        video_path = f"/media/{relative_path}"
        result = await hass.async_add_executor_job(_find_analysis_for_video, analysis_output_path, video_path)
        if result:
            result.pop("frames", None)
            # Filter out ignored embeddings from face results using similarity matching
            ignored_embs = await get_ignored_embeddings()
            if ignored_embs and "detections" in result:
                # Use same threshold as face matching (0.85 = very high similarity)
                IGNORE_THRESHOLD = 0.85
                
                def is_ignored(face_emb):
                    """Check if embedding matches any ignored embedding."""
                    if not face_emb:
                        return False
                    for ign_emb in ignored_embs:
                        if ign_emb and _cosine_similarity_simple(face_emb, ign_emb) >= IGNORE_THRESHOLD:
                            return True
                    return False
                
                for detection in result["detections"]:
                    if "faces" in detection:
                        detection["faces"] = [
                            f for f in detection["faces"]
                            if not is_ignored(f.get("embedding"))
                        ]
        connection.send_result(msg["id"], result or {})

    websocket_api.async_register_command(hass, ws_get_analysis_result)

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/get_detector_stats",
    })
    @websocket_api.async_response
    async def ws_get_detector_stats(hass, connection, msg):
        """Return detector stats including CPU, Coral status, inference times."""
        stats = await _fetch_detector_stats(analysis_detector_url)
        perf = {
            "cpu": _sensor_info(analysis_perf_cpu_entity),
            "igpu": _sensor_info(analysis_perf_igpu_entity),
            "coral": _sensor_info(analysis_perf_coral_entity),
        }
        stats["perf_sensors"] = perf
        # v1.2.3: Use inference_stats from detector directly instead of local tracker
        # The detector's /stats endpoint provides the correct values
        stats["system_stats"] = await hass.async_add_executor_job(get_system_stats)
        connection.send_result(msg["id"], stats)

    websocket_api.async_register_command(hass, ws_get_detector_stats)

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/reset_detector_stats",
    })
    @websocket_api.async_response
    @limit("rtsp_recorder/reset_detector_stats")
    async def ws_reset_detector_stats(hass, connection, msg):
        """Reset detector statistics (inference count, timing, etc.)."""
        result = {"success": False, "message": "Unknown error"}
        
        if not analysis_detector_url:
            result["message"] = "Detector URL not configured"
            connection.send_result(msg["id"], result)
            return
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{analysis_detector_url.rstrip('/')}/stats/reset",
                    timeout=10
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        result["success"] = True
                        result["message"] = data.get("message", "Statistics reset successfully")
                    elif resp.status == 404:
                        result["message"] = "Reset endpoint not supported by detector"
                    else:
                        result["message"] = f"HTTP error {resp.status}"
        except asyncio.TimeoutError:
            result["message"] = "Connection timeout"
        except Exception as e:
            result["message"] = str(e)
        
        connection.send_result(msg["id"], result)

    websocket_api.async_register_command(hass, ws_reset_detector_stats)

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/test_inference",
    })
    @websocket_api.async_response
    @limit("rtsp_recorder/test_inference")
    async def ws_test_inference(hass, connection, msg):
        """Run a single test inference to populate Coral statistics."""
        import time as _t
        import io
        result = {"success": False, "message": "Unknown error", "device": None, "duration_ms": 0}
        
        if not analysis_detector_url:
            result["message"] = "Detector URL not configured"
            connection.send_result(msg["id"], result)
            return
        
        try:
            # Create a valid JPEG test image using PIL
            try:
                from PIL import Image
                img = Image.new('RGB', (320, 240), color=(128, 128, 128))
                buf = io.BytesIO()
                img.save(buf, format='JPEG', quality=70)
                test_image = buf.getvalue()
            except ImportError:
                import base64
                test_image = base64.b64decode(
                    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof'
                    'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwh'
                    'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAAR'
                    'CAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAA'
                    'AAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMB'
                    'AAIRAxEAPwCwAB//2Q=='
                )
            
            async with aiohttp.ClientSession() as session:
                form = aiohttp.FormData()
                form.add_field("file", test_image, filename="test.jpg", content_type="image/jpeg")
                form.add_field("confidence", "0.1")
                form.add_field("device", "coral_usb")
                
                start = _t.time()
                async with session.post(f"{analysis_detector_url.rstrip('/')}/detect", data=form, timeout=30) as resp:
                    duration_ms = (_t.time() - start) * 1000
                    if resp.status == 200:
                        data = await resp.json()
                        used_device = data.get("device", "cpu")
                        _inference_stats.record(used_device, duration_ms, 1)
                        result = {
                            "success": True,
                            "message": f"Test inference completed on {used_device}",
                            "device": used_device,
                            "duration_ms": round(duration_ms, 1),
                            "detections": len(data.get("detections", []))
                        }
                    else:
                        body = await resp.text()
                        result["message"] = f"Detector returned status {resp.status}: {body[:100]}"
        except Exception as e:
            import traceback
            result["message"] = f"{str(e)}"
            log_to_file(f"Test inference error: {traceback.format_exc()}")
        
        connection.send_result(msg["id"], result)

    websocket_api.async_register_command(hass, ws_test_inference)

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/get_analysis_config",
        vol.Optional("camera"): str,
    })
    @websocket_api.async_response
    async def ws_get_analysis_config(hass, connection, msg):
        """Return current analysis schedule configuration."""
        camera = msg.get("camera")
        
        cam_objects = None
        if camera:
            safe_cam = camera.replace(" ", "_").replace("-", "_")
            cam_objects_key = f"analysis_objects_{safe_cam}"
            cam_objects = config_data.get(cam_objects_key, [])
        
        camera_objects_map = {}
        for key, value in config_data.items():
            if key.startswith("analysis_objects_"):
                cam_name = key.replace("analysis_objects_", "")
                camera_objects_map[cam_name] = value
        
        result = {
            "analysis_enabled": analysis_enabled,
            "analysis_auto_enabled": analysis_auto_enabled,
            "analysis_auto_mode": analysis_auto_mode,
            "analysis_auto_time": analysis_auto_time,
            "analysis_auto_interval_hours": analysis_auto_interval_hours,
            "analysis_auto_since_days": analysis_auto_since_days,
            "analysis_auto_limit": analysis_auto_limit,
            "analysis_auto_skip_existing": analysis_auto_skip_existing,
            "analysis_auto_new": analysis_auto_new,
            "analysis_auto_force_coral": analysis_auto_force_coral,
            "person_entities_enabled": person_entities_enabled,
            "analysis_device": analysis_device,
            "analysis_objects": analysis_objects,
            "analysis_max_concurrent": config_data.get("analysis_max_concurrent", 2),
            "analysis_face_enabled": analysis_face_enabled,
            "analysis_face_confidence": analysis_face_confidence,
            "analysis_face_match_threshold": analysis_face_match_threshold,
            "analysis_overlay_smoothing": config_data.get("analysis_overlay_smoothing", False),
            "analysis_overlay_smoothing_alpha": config_data.get("analysis_overlay_smoothing_alpha", 0.35),
            "analysis_face_store_embeddings": analysis_face_store_embeddings,
            "camera_objects": cam_objects,
            "camera_objects_map": camera_objects_map,
            "storage_path": storage_path,
            "snapshot_path": snapshot_path_base,
        }
        connection.send_result(msg["id"], result)

    websocket_api.async_register_command(hass, ws_get_analysis_config)

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/set_analysis_config",
        vol.Optional("analysis_auto_enabled"): bool,
        vol.Optional("analysis_auto_mode"): str,
        vol.Optional("analysis_auto_time"): str,
        vol.Optional("analysis_auto_interval_hours"): int,
        vol.Optional("analysis_auto_since_days"): int,
        vol.Optional("analysis_auto_limit"): int,
        vol.Optional("analysis_auto_skip_existing"): bool,
        vol.Optional("analysis_auto_new"): bool,
    })
    @websocket_api.async_response
    @limit("rtsp_recorder/set_analysis_config")
    async def ws_set_analysis_config(hass, connection, msg):
        """Update analysis schedule configuration."""
        try:
            updatable_fields = [
                "analysis_auto_enabled",
                "analysis_auto_mode", 
                "analysis_auto_time",
                "analysis_auto_interval_hours",
                "analysis_auto_since_days",
                "analysis_auto_limit",
                "analysis_auto_skip_existing",
                "analysis_auto_new",
            ]
            
            updates = {}
            for field in updatable_fields:
                if field in msg:
                    updates[field] = msg[field]
            
            new_data = dict(entry.data)
            new_options = dict(entry.options) if entry.options else {}
            
            new_data.update(updates)
            new_options.update(updates)
            
            hass.config_entries.async_update_entry(entry, data=new_data, options=new_options)
            
            connection.send_result(msg["id"], {
                "success": True,
                "message": "Config updated. Reload integration for scheduler changes to take effect.",
                "updated": updates
            })
        except Exception as e:
            log_to_file(f"Set analysis config error: {e}")
            connection.send_result(msg["id"], {
                "success": False,
                "message": str(e)
            })

    websocket_api.async_register_command(hass, ws_set_analysis_config)

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/set_camera_objects",
        vol.Required("camera"): str,
        vol.Required("objects"): list,
    })
    @websocket_api.async_response
    @limit("rtsp_recorder/set_camera_objects")
    async def ws_set_camera_objects(hass, connection, msg):
        """Set camera-specific analysis objects."""
        try:
            camera = msg["camera"]
            objects = msg["objects"]
            
            safe_cam = camera.replace(" ", "_").replace("-", "_")
            cam_objects_key = f"analysis_objects_{safe_cam}"
            
            new_data = dict(entry.data)
            new_options = dict(entry.options) if entry.options else {}
            
            if objects:
                new_data[cam_objects_key] = objects
                new_options[cam_objects_key] = objects
            else:
                new_data.pop(cam_objects_key, None)
                new_options.pop(cam_objects_key, None)
            
            hass.config_entries.async_update_entry(entry, data=new_data, options=new_options)
            
            log_to_file(f"Set camera objects for {camera}: {objects}")
            
            connection.send_result(msg["id"], {
                "success": True,
                "camera": camera,
                "objects": objects,
                "message": f"Objects for {camera} updated"
            })
        except Exception as e:
            log_to_file(f"Set camera objects error: {e}")
            connection.send_result(msg["id"], {
                "success": False,
                "message": str(e)
            })

    websocket_api.async_register_command(hass, ws_set_camera_objects)

    # ===== v1.4.0: per-camera analysis settings (clean global/per-cam separation) =====
    def _merged_config() -> dict:
        """Current merged config (options shadow data), freshly read from the entry."""
        return {**entry.data, **(entry.options or {})}

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/get_camera_settings",
        vol.Optional("camera"): str,
    })
    @websocket_api.async_response
    async def ws_get_camera_settings(hass, connection, msg):
        """Return per-camera analysis settings.

        Without ``camera``: returns the global defaults plus, for every camera that
        has at least one override, the raw overridden values. With ``camera``: returns
        that camera's effective (resolved) values AND which of them are overrides.
        Reads the entry live so values are correct even before a reload.
        """
        try:
            cfg = _merged_config()
            fields = [f.global_key for f in _cam.PER_CAMERA_FIELDS]
            globals_ = {k: cfg.get(k) for k in fields}
            camera = msg.get("camera")
            if camera:
                connection.send_result(msg["id"], {
                    "success": True,
                    "camera": camera,
                    "globals": globals_,
                    "effective": _cam.resolve_all(cfg, camera),
                    "overrides": _cam.camera_overrides(cfg, camera),
                })
                return
            # Map of camera -> overrides for every camera that has any override.
            overrides_map: dict = {}
            for key in cfg:
                for f in _cam.PER_CAMERA_FIELDS:
                    if key.startswith(f.prefix):
                        cam = key[len(f.prefix):]
                        overrides_map.setdefault(cam, {})[f.global_key] = cfg.get(key)
            connection.send_result(msg["id"], {
                "success": True,
                "globals": globals_,
                "fields": fields,
                "overrides_by_camera": overrides_map,
            })
        except Exception as e:  # noqa: BLE001 - report any failure to the UI
            log_to_file(f"get_camera_settings error: {e}")
            connection.send_result(msg["id"], {"success": False, "message": str(e)})

    websocket_api.async_register_command(hass, ws_get_camera_settings)

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/set_camera_setting",
        vol.Required("camera"): str,
        vol.Required("field"): str,
        # value may be float/int/bool/list/null; vol.Any keeps it permissive,
        # camera_settings coerces to the field's declared type.
        vol.Required("value"): vol.Any(float, int, bool, list, str, None),
    })
    @websocket_api.async_response
    @limit("rtsp_recorder/set_camera_setting")
    async def ws_set_camera_setting(hass, connection, msg):
        """Set or clear a single per-camera analysis override.

        ``field`` is a global key (e.g. ``analysis_detector_confidence``). A value
        meaning "use global" (None/empty/0 for legacy zero-sentinel fields) clears
        the override. Writes BOTH entry.data and entry.options (Phase-1 data/options
        duality) and reloads the entry so the running analysis picks it up.
        """
        try:
            camera = msg["camera"]
            field = msg["field"]
            value = msg["value"]
            if _cam.get_field(field) is None:
                connection.send_result(msg["id"], {
                    "success": False,
                    "message": f"{field} is not a per-camera field",
                })
                return
            new_data = dict(entry.data)
            new_options = dict(entry.options) if entry.options else {}
            _cam.set_override(new_data, field, camera, value)
            _cam.set_override(new_options, field, camera, value)
            # async_update_entry triggers the registered update_listener
            # (__init__.py) which performs async_reload itself; no explicit
            # reload here (would double-reload / race).
            hass.config_entries.async_update_entry(entry, data=new_data, options=new_options)
            log_to_file(f"Set camera setting {field} for {camera} = {value}")
            connection.send_result(msg["id"], {
                "success": True,
                "camera": camera,
                "field": field,
                "value": value,
            })
        except Exception as e:  # noqa: BLE001
            log_to_file(f"set_camera_setting error: {e}")
            connection.send_result(msg["id"], {"success": False, "message": str(e)})

    websocket_api.async_register_command(hass, ws_set_camera_setting)

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/delete_camera",
        vol.Required("camera"): str,
    })
    @websocket_api.async_response
    @limit("rtsp_recorder/delete_camera")
    async def ws_delete_camera(hass, connection, msg):
        """Delete all config keys for a camera (config/entities only; recordings stay).

        Removes every per-camera key (sensors_, duration_, rtsp_url_, all analysis
        overrides, ...) from BOTH entry.data and entry.options, then reloads the
        entry so motion listeners / watchdog for the camera are torn down. On-disk
        recordings, snapshots and analysis results are intentionally left untouched.
        """
        try:
            camera = msg["camera"]
            new_data = dict(entry.data)
            new_options = dict(entry.options) if entry.options else {}
            removed = _cam.delete_camera(new_data, new_options, camera)
            if not removed:
                connection.send_result(msg["id"], {
                    "success": False,
                    "camera": camera,
                    "message": "No config keys found for this camera",
                })
                return
            # async_update_entry triggers the registered update_listener which
            # reloads the entry (tears down the camera's motion listeners/watchdog).
            hass.config_entries.async_update_entry(entry, data=new_data, options=new_options)
            log_to_file(f"Deleted camera '{camera}' config keys: {removed}")
            connection.send_result(msg["id"], {
                "success": True,
                "camera": camera,
                "removed_keys": removed,
                "message": (
                    f"Removed {len(removed)} config keys for {camera}. "
                    "Recordings on disk were kept."
                ),
            })
        except Exception as e:  # noqa: BLE001
            log_to_file(f"delete_camera error: {e}")
            connection.send_result(msg["id"], {"success": False, "message": str(e)})

    websocket_api.async_register_command(hass, ws_delete_camera)

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/get_cameras",
    })
    @websocket_api.async_response
    async def ws_get_cameras(hass, connection, msg):
        """Return the list of configured cameras (canonical key + display name).

        Derived from the camera base keys in the live entry config (sensors_,
        rtsp_url_, duration_, ...). ``key`` is the canonical config-key suffix used
        by set_camera_setting/delete_camera; ``name`` is a human-friendly label.
        Provides the complete, reliable camera list that the panel's Per-Camera and
        Delete tabs need (no get_cameras command existed before v1.4.0).
        """
        try:
            cfg = _merged_config()
            cams = [
                {"key": k, "name": k.replace("_", " ")}
                for k in _cam.list_cameras(cfg)
            ]
            connection.send_result(msg["id"], {"success": True, "cameras": cams})
        except Exception as e:  # noqa: BLE001
            log_to_file(f"get_cameras error: {e}")
            connection.send_result(msg["id"], {"success": False, "message": str(e)})

    websocket_api.async_register_command(hass, ws_get_cameras)

    # Whitelist of GLOBAL (non-per-camera) config keys the panel may persist via
    # set_global_settings. Per-camera keys are handled exclusively by
    # set_camera_setting; writing them here is rejected so the flat per-camera
    # schema is never clobbered.
    _GLOBAL_SETTINGS_WHITELIST = frozenset({
        # --- analysis core ---
        "analysis_enabled", "analysis_device", "analysis_objects",
        "analysis_output_path", "analysis_frame_interval", "analysis_max_concurrent",
        "analysis_detector_url", "analysis_detector_confidence",
        "analysis_face_enabled", "analysis_face_confidence",
        "analysis_face_match_threshold", "analysis_face_multiscale",
        "analysis_overlay_smoothing", "analysis_overlay_smoothing_alpha",
        "person_entities_enabled",
        # --- auto scheduler ---
        "analysis_auto_enabled", "analysis_auto_mode", "analysis_auto_time",
        "analysis_auto_interval_hours", "analysis_auto_since_days",
        "analysis_auto_limit", "analysis_auto_skip_existing", "analysis_auto_new",
        # --- performance sensor entities ---
        "analysis_perf_cpu_entity", "analysis_perf_igpu_entity",
        "analysis_perf_coral_entity",
        # --- storage / retention ---
        "storage_path", "snapshot_path", "retention_days",
        "snapshot_retention_days", "cleanup_interval_hours", "retention_hours",
        # --- UI ---
        "sidebar_panel_enabled",
        # --- rate limiter (HIGH-001); takes effect on reload via __init__ ---
        "rate_limit_mode", "rate_limit_requests_per_window", "rate_limit_burst_size",
    })
    _GLOBAL_PATH_KEYS = frozenset({
        "storage_path", "snapshot_path", "analysis_output_path",
    })

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/set_global_settings",
        vol.Required("settings"): dict,
    })
    @websocket_api.async_response
    @limit("rtsp_recorder/set_global_settings")
    async def ws_set_global_settings(hass, connection, msg):
        """Persist one or more GLOBAL settings (defaults that apply to all cameras).

        Only whitelisted, non-per-camera keys are accepted; path keys must be
        absolute (mirror config_flow validation). Writes BOTH entry.data and
        entry.options; async_update_entry triggers the registered update_listener
        which reloads the entry, so no explicit reload here (would double-reload).
        """
        try:
            incoming = msg["settings"] or {}
            rejected = [k for k in incoming if k not in _GLOBAL_SETTINGS_WHITELIST]
            if rejected:
                connection.send_result(msg["id"], {
                    "success": False,
                    "message": f"Not global-settable keys: {sorted(rejected)}",
                })
                return
            for pkey in _GLOBAL_PATH_KEYS:
                if pkey in incoming:
                    val = incoming[pkey]
                    if not isinstance(val, str) or not val.startswith("/"):
                        connection.send_result(msg["id"], {
                            "success": False,
                            "message": f"{pkey} must be an absolute path (start with '/')",
                        })
                        return
            updates = dict(incoming)
            new_data = dict(entry.data)
            new_options = dict(entry.options) if entry.options else {}
            new_data.update(updates)
            new_options.update(updates)
            hass.config_entries.async_update_entry(entry, data=new_data, options=new_options)
            log_to_file(f"Set global settings: {sorted(updates.keys())}")
            connection.send_result(msg["id"], {
                "success": True,
                "updated": updates,
                "message": f"Saved {len(updates)} global setting(s).",
            })
        except Exception as e:  # noqa: BLE001
            log_to_file(f"set_global_settings error: {e}")
            connection.send_result(msg["id"], {"success": False, "message": str(e)})

    websocket_api.async_register_command(hass, ws_set_global_settings)

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/get_global_settings",
    })
    @websocket_api.async_response
    async def ws_get_global_settings(hass, connection, msg):
        """Return current values of every global-settable key (for the panel forms)."""
        try:
            cfg = _merged_config()
            connection.send_result(msg["id"], {
                "success": True,
                "settings": {k: cfg.get(k) for k in _GLOBAL_SETTINGS_WHITELIST},
            })
        except Exception as e:  # noqa: BLE001
            log_to_file(f"get_global_settings error: {e}")
            connection.send_result(msg["id"], {"success": False, "message": str(e)})

    websocket_api.async_register_command(hass, ws_get_global_settings)

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/get_rate_limit_stats",
    })
    @websocket_api.async_response
    async def ws_get_rate_limit_stats(hass, connection, msg):
        """Return rate limiter stats (read-only; for the panel / shadow-mode profiling)."""
        try:
            limiter = (hass.data.get(DOMAIN, {}) or {}).get("rate_limiter")
            stats = limiter.get_stats() if limiter is not None else {"mode": "off"}
            connection.send_result(msg["id"], {"success": True, "stats": stats})
        except Exception as e:  # noqa: BLE001
            connection.send_result(msg["id"], {"success": False, "message": str(e)})

    websocket_api.async_register_command(hass, ws_get_rate_limit_stats)

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/get_camera_base",
        vol.Required("camera"): str,
    })
    @websocket_api.async_response
    async def ws_get_camera_base(hass, connection, msg):
        """Return a camera's base recording settings (sensors/duration/delay/url/retention)."""
        try:
            cfg = _merged_config()
            connection.send_result(msg["id"], {
                "success": True,
                "camera": msg["camera"],
                "base": _cam.read_camera_base(cfg, msg["camera"]),
            })
        except Exception as e:  # noqa: BLE001
            log_to_file(f"get_camera_base error: {e}")
            connection.send_result(msg["id"], {"success": False, "message": str(e)})

    websocket_api.async_register_command(hass, ws_get_camera_base)

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/set_camera_base",
        vol.Required("camera"): str,
        vol.Optional("motion_sensors"): list,
        vol.Optional("recording_duration"): vol.Any(int, float),
        vol.Optional("snapshot_delay"): vol.Any(int, float),
        vol.Optional("rtsp_url"): str,
        vol.Optional("camera_retention"): vol.Any(int, float),
        vol.Optional("camera_enabled"): bool,
    })
    @websocket_api.async_response
    @limit("rtsp_recorder/set_camera_base")
    async def ws_set_camera_base(hass, connection, msg):
        """Set a camera's base recording settings. Writes entry.data+options; reload via listener."""
        try:
            fields = {k: msg[k] for k in _cam.CAMERA_BASE_FIELDS if k in msg}
            if not fields:
                connection.send_result(msg["id"], {"success": False, "message": "no base fields provided"})
                return
            new_data = dict(entry.data)
            new_options = dict(entry.options) if entry.options else {}
            touched = _cam.set_camera_base(new_data, new_options, msg["camera"], fields)
            hass.config_entries.async_update_entry(entry, data=new_data, options=new_options)
            log_to_file(f"set_camera_base {msg['camera']}: {touched}")
            connection.send_result(msg["id"], {"success": True, "camera": msg["camera"], "touched_keys": touched})
        except Exception as e:  # noqa: BLE001
            log_to_file(f"set_camera_base error: {e}")
            connection.send_result(msg["id"], {"success": False, "message": str(e)})

    websocket_api.async_register_command(hass, ws_set_camera_base)

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/add_camera",
        vol.Required("camera_name"): str,
        vol.Required("rtsp_url"): str,
        vol.Optional("motion_sensors"): list,
        vol.Optional("recording_duration"): vol.Any(int, float),
        vol.Optional("snapshot_delay"): vol.Any(int, float),
        vol.Optional("camera_retention"): vol.Any(int, float),
    })
    @websocket_api.async_response
    @limit("rtsp_recorder/add_camera")
    async def ws_add_camera(hass, connection, msg):
        """Add a new manual RTSP camera (mirrors the old manual_camera config step).

        Validates name + rtsp:// scheme and rejects duplicates, then writes the base
        keys for the camera. Reload happens via the update_listener.
        """
        try:
            name = (msg.get("camera_name") or "").strip()
            url = (msg.get("rtsp_url") or "").strip()
            if not name:
                connection.send_result(msg["id"], {"success": False, "message": "Bitte einen Kameranamen angeben"})
                return
            if not (url.startswith("rtsp://") or url.startswith("rtsps://")):
                connection.send_result(msg["id"], {"success": False, "message": "RTSP-URL muss mit rtsp:// oder rtsps:// beginnen"})
                return
            cfg = _merged_config()
            safe = _cam.camera_key(name)
            if any(f"{p}{safe}" in cfg for p in _cam.CAMERA_BASE_PREFIXES):
                connection.send_result(msg["id"], {"success": False, "message": f"Kamera '{name}' existiert bereits"})
                return
            fields = {
                "rtsp_url": url,
                "recording_duration": int(msg.get("recording_duration", 120)),
                "snapshot_delay": int(msg.get("snapshot_delay", 0)),
                "camera_retention": float(msg.get("camera_retention", 0)),
            }
            if msg.get("motion_sensors"):
                fields["motion_sensors"] = msg["motion_sensors"]
            new_data = dict(entry.data)
            new_options = dict(entry.options) if entry.options else {}
            touched = _cam.set_camera_base(new_data, new_options, name, fields)
            hass.config_entries.async_update_entry(entry, data=new_data, options=new_options)
            log_to_file(f"add_camera '{name}' (key={safe}): {touched}")
            connection.send_result(msg["id"], {"success": True, "camera": safe, "name": name, "touched_keys": touched})
        except Exception as e:  # noqa: BLE001
            log_to_file(f"add_camera error: {e}")
            connection.send_result(msg["id"], {"success": False, "message": str(e)})

    websocket_api.async_register_command(hass, ws_add_camera)


def register_people_websocket_handlers(
    hass,
    analysis_output_path: str,
    analysis_face_match_threshold: float,
    validate_person_name_func,
) -> None:
    """Register People DB WebSocket handlers.
    
    Args:
        hass: Home Assistant instance
        analysis_output_path: Path to analysis output directory
        analysis_face_match_threshold: Face matching threshold
        validate_person_name_func: Function to validate person names
    """
    import uuid

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/get_people",
    })
    @websocket_api.async_response
    async def ws_get_people(hass, connection, msg):
        """Get all people from database."""
        data = await _load_people_db()
        people_view = _public_people_view(data.get("people", []))
        log_to_file(f"WS get_people -> {people_view}")
        connection.send_result(msg["id"], {"people": people_view})

    websocket_api.async_register_command(hass, ws_get_people)

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/add_person",
        vol.Required("name"): str,
    })
    @websocket_api.async_response
    @limit("rtsp_recorder/add_person")
    async def ws_add_person(hass, connection, msg):
        """Add a new person to database."""
        name = (msg.get("name") or "").strip()
        is_valid, error_msg = validate_person_name_func(name)
        if not is_valid:
            connection.send_error(msg["id"], "invalid_name", error_msg)
            return
        
        person_id = uuid.uuid4().hex
        created_utc = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d_%H%M%S")
        
        # v1.1.0: Use SQLite if enabled
        if is_sqlite_enabled():
            success = await _save_person_to_sqlite(person_id, name)
            if not success:
                connection.send_error(msg["id"], "db_error", "Fehler beim Speichern in SQLite")
                return
            person = {"id": person_id, "name": name, "created_utc": created_utc, "embeddings": []}
        
        connection.send_result(msg["id"], {"person": _public_people_view([person])[0]})

    websocket_api.async_register_command(hass, ws_add_person)

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/rename_person",
        vol.Required("id"): vol.Any(str, int),
        vol.Required("name"): str,
    })
    @websocket_api.async_response
    @limit("rtsp_recorder/rename_person")
    async def ws_rename_person(hass, connection, msg):
        """Rename an existing person."""
        person_id = str(msg.get("id"))
        name = (msg.get("name") or "").strip()
        is_valid, error_msg = validate_person_name_func(name)
        if not is_valid:
            connection.send_error(msg["id"], "invalid_name", error_msg)
            return
        
        # v1.1.0: Use SQLite if enabled
        if is_sqlite_enabled():
            success = await _rename_person_in_sqlite(person_id, name)
            if not success:
                connection.send_error(msg["id"], "not_found", "Person nicht gefunden")
                return
            # Reload to get updated view
            data = await _load_people_db()
            people = data.get("people", [])
            updated = next((p for p in people if str(p.get("id")) == person_id), None)
            if updated:
                connection.send_result(msg["id"], {"person": _public_people_view([updated])[0]})
            else:
                connection.send_result(msg["id"], {"person": {"id": person_id, "name": name}})
            return

    websocket_api.async_register_command(hass, ws_rename_person)

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/delete_person",
        vol.Required("id"): vol.Any(str, int),
        vol.Optional("name"): str,
        vol.Optional("created_utc"): str,
    })
    @websocket_api.async_response
    @limit("rtsp_recorder/delete_person")
    async def ws_delete_person(hass, connection, msg):
        """Delete a person from database."""
        log_to_file(f"WS delete_person payload: {msg}")
        person_id = str(msg.get("id"))
        name = (msg.get("name") or "").strip()
        created_utc = (msg.get("created_utc") or "").strip()
        
        # v1.1.0: Use SQLite if enabled
        if is_sqlite_enabled():
            success = await _delete_person_from_sqlite(person_id)
            if success:
                connection.send_result(msg["id"], {"deleted": True})
            else:
                connection.send_error(msg["id"], "not_found", "Person nicht gefunden")
            return

    websocket_api.async_register_command(hass, ws_delete_person)

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/add_person_embedding",
        vol.Required("person_id"): vol.Any(str, int),
        vol.Required("embedding"): list,
        vol.Optional("name"): str,
        vol.Optional("created_utc"): str,
        vol.Optional("thumb"): str,
        vol.Optional("source", default="manual"): str,
    })
    @websocket_api.async_response
    @limit("rtsp_recorder/add_person_embedding")
    async def ws_add_person_embedding(hass, connection, msg):
        """Add embedding to a person for face training."""
        log_to_file(f"INIT: add_person_embedding called with person_id={msg.get('person_id')}, embedding_len={len(msg.get('embedding') or [])}")
        try:
            person_id = str(msg.get("person_id"))
            name = (msg.get("name") or "").strip()
            created_utc = (msg.get("created_utc") or "").strip()
            thumb = msg.get("thumb")
            embedding = msg.get("embedding") or []
            try:
                embedding = [float(v) for v in embedding]
            except Exception:
                connection.send_error(msg["id"], "invalid_embedding", "Embedding ungueltig")
                return
            embedding = _normalize_embedding_simple(embedding)
            if not embedding:
                connection.send_error(msg["id"], "invalid_embedding", "Embedding ungueltig")
                return
            
            # v1.1.0: Use SQLite if enabled
            if is_sqlite_enabled():
                success = await _add_embedding_to_sqlite(person_id, embedding, thumb)
                if success:
                    # Reload to get updated view
                    data = await _load_people_db()
                    people = data.get("people", [])
                    updated = next((p for p in people if str(p.get("id")) == person_id), None)
                    if updated:
                        connection.send_result(msg["id"], {"person": _public_people_view([updated])[0]})
                    else:
                        connection.send_result(msg["id"], {"person": {"id": person_id, "embeddings_count": 1}})
                else:
                    connection.send_error(msg["id"], "db_error", "Fehler beim Speichern in SQLite")
                return
            
        except Exception as exc:
            log_to_file(f"INIT: add_person_embedding ERROR: {type(exc).__name__}: {exc}")
            connection.send_error(msg["id"], "error", f"{type(exc).__name__}: {exc}")

    websocket_api.async_register_command(hass, ws_add_person_embedding)

    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/add_negative_sample",
        vol.Required("person_id"): str,
        vol.Required("embedding"): list,
        vol.Optional("thumb"): str,
        vol.Optional("source"): str,
    })
    @websocket_api.async_response
    @limit("rtsp_recorder/add_negative_sample")
    async def ws_add_negative_sample(hass, connection, msg):
        """Add a negative sample to a person (mark as 'NOT this person')."""
        log_to_file(f"INIT: add_negative_sample called for person_id={msg.get('person_id')}")
        try:
            person_id = str(msg.get("person_id"))
            embedding = msg.get("embedding") or []
            thumb = msg.get("thumb")
            source = msg.get("source", "manual")
            
            try:
                embedding = [float(v) for v in embedding]
            except Exception:
                connection.send_error(msg["id"], "invalid_embedding", "Embedding ungueltig")
                return
            
            embedding = _normalize_embedding_simple(embedding)
            if not embedding:
                connection.send_error(msg["id"], "invalid_embedding", "Embedding ungueltig")
                return
            
            # v1.1.0j: SQLite-only - use database directly
            from .database import get_database
            db = get_database()
            if not db:
                connection.send_error(msg["id"], "db_error", "Database not available")
                return
            
            result = await asyncio.to_thread(
                db.add_negative_embedding, person_id, embedding, source=source, thumb=thumb
            )
            if result <= 0:
                connection.send_error(msg["id"], "db_error", "Failed to add negative embedding")
                return

            neg_count = await hass.async_add_executor_job(db.get_negative_count_for_person, person_id)

            # Get person name for logging
            person = await hass.async_add_executor_job(db.get_person, person_id)
            person_name = person.get("name", "Unknown") if person else "Unknown"
            log_to_file(f"INIT: Added negative sample to {person_name} (total: {neg_count})")
            
            connection.send_result(msg["id"], {
                "success": True,
                "person_id": person_id,
                "negative_count": neg_count
            })
            
        except Exception as exc:
            log_to_file(f"INIT: add_negative_sample ERROR: {type(exc).__name__}: {exc}")
            connection.send_error(msg["id"], "error", f"{type(exc).__name__}: {exc}")

    websocket_api.async_register_command(hass, ws_add_negative_sample)

    # ===== Add Ignored Embedding Handler =====
    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/add_ignored_embedding",
        vol.Required("embedding"): list,
        vol.Optional("thumb"): str,
    })
    @websocket_api.async_response
    @limit("rtsp_recorder/add_ignored_embedding")
    async def ws_add_ignored_embedding(hass, connection, msg):
        """Add an embedding to the ignored list (skip this face in future)."""
        log_to_file("INIT: add_ignored_embedding called")
        try:
            embedding = msg.get("embedding") or []
            thumb = msg.get("thumb")

            try:
                embedding = [float(v) for v in embedding]
            except Exception:
                connection.send_error(msg["id"], "invalid_embedding", "Embedding ungueltig")
                return

            embedding = _normalize_embedding_simple(embedding)
            if not embedding:
                connection.send_error(msg["id"], "invalid_embedding", "Embedding ungueltig")
                return

            # Import here to avoid circular imports
            from .people_db import add_ignored_embedding, get_ignored_count
            
            await add_ignored_embedding(embedding, thumb)
            ignored_count = await get_ignored_count()
            
            log_to_file(f"INIT: Added ignored embedding (total: {ignored_count})")

            connection.send_result(msg["id"], {
                "success": True,
                "ignored_count": ignored_count
            })

        except Exception as exc:
            log_to_file(f"INIT: add_ignored_embedding ERROR: {type(exc).__name__}: {exc}")
            connection.send_error(msg["id"], "error", f"{type(exc).__name__}: {exc}")

    websocket_api.async_register_command(hass, ws_add_ignored_embedding)
    # ===== v1.1.0: Get Movement Profile (Recognition History) =====
    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/get_movement_profile",
        vol.Optional("person_name"): str,
        vol.Optional("hours"): vol.Coerce(int),
    })
    @websocket_api.async_response
    async def ws_get_movement_profile(hass, connection, msg):
        """Get movement profile showing when/where a person was detected.
        
        Returns a timeline of detections with camera locations.
        """
        log_to_file("INIT: get_movement_profile called")
        try:
            person_name = msg.get("person_name")
            hours = msg.get("hours", 24)  # Default: last 24 hours
            
            from .people_db import is_sqlite_enabled
            from .database import DatabaseManager
            
            if not is_sqlite_enabled():
                connection.send_result(msg["id"], {
                    "success": False,
                    "error": "SQLite backend not enabled",
                    "movements": []
                })
                return
            
            # Query recognition_history
            import datetime
            from pathlib import Path
            
            db_path = Path(hass.config.path("rtsp_recorder")) / "rtsp_recorder.db"
            
            # Get history entries
            since = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=hours)
            
            query = """
                SELECT person_name, camera_name, recognized_at, confidence, recording_path
                FROM recognition_history
                WHERE recognized_at >= ?
            """
            params = [since.isoformat()]
            
            if person_name:
                query += " AND person_name = ?"
                params.append(person_name)
            
            query += " ORDER BY recognized_at DESC LIMIT 500"
            
            # Run the blocking DB work off the event loop: opening the DatabaseManager
            # (incl. os.makedirs) + query + fetchall. The inline connection is closed in
            # finally so it no longer leaks (it was previously never closed).
            def _fetch_rows():
                db = DatabaseManager(str(db_path))
                try:
                    return db.conn.execute(query, params).fetchall()
                finally:
                    db.close()

            rows = await hass.async_add_executor_job(_fetch_rows)
            
            movements = []
            for row in rows:
                movements.append({
                    "person": row[0],
                    "camera": row[1],
                    "time": row[2],
                    "confidence": row[3],
                    "video": row[4]
                })
            
            # Group by person for summary
            summary = {}
            for m in movements:
                person = m["person"] or "Unbekannt"
                if person not in summary:
                    summary[person] = []
                summary[person].append({
                    "camera": m["camera"],
                    "time": m["time"],
                    "confidence": m["confidence"]
                })
            
            connection.send_result(msg["id"], {
                "success": True,
                "movements": movements,
                "summary": summary,
                "total": len(movements),
                "hours": hours
            })
            
        except Exception as exc:
            log_to_file(f"INIT: get_movement_profile ERROR: {type(exc).__name__}: {exc}")
            connection.send_error(msg["id"], "error", f"{type(exc).__name__}: {exc}")

    websocket_api.async_register_command(hass, ws_get_movement_profile)

    # ===== v1.1.0n: Get Person Details (for Detail Popup) =====
    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/get_person_details",
        vol.Required("person_id"): str,
    })
    @websocket_api.async_response
    async def ws_get_person_details(hass, connection, msg):
        """Get comprehensive person details including all embeddings with IDs.
        
        Returns positive samples, negative samples, stats for the person detail popup.
        """
        log_to_file(f"INIT: get_person_details called for person_id={msg.get('person_id')}")
        try:
            person_id = str(msg.get("person_id"))
            
            from .database import get_database
            db = get_database()
            if not db:
                connection.send_error(msg["id"], "db_error", "Database not available")
                return
            
            details = await hass.async_add_executor_job(db.get_person_details, person_id)
            if not details:
                connection.send_error(msg["id"], "not_found", f"Person {person_id} not found")
                return
            
            log_to_file(f"INIT: get_person_details returning {details.get('positive_count', 0)} positive, {details.get('negative_count', 0)} negative samples")
            connection.send_result(msg["id"], details)
            
        except Exception as exc:
            log_to_file(f"INIT: get_person_details ERROR: {type(exc).__name__}: {exc}")
            connection.send_error(msg["id"], "error", f"{type(exc).__name__}: {exc}")

    websocket_api.async_register_command(hass, ws_get_person_details)

    # ===== v1.1.0n: Delete Embedding (positive or negative) =====
    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/delete_embedding",
        vol.Required("embedding_id"): int,
        vol.Required("embedding_type"): str,  # "positive" or "negative"
    })
    @websocket_api.async_response
    @limit("rtsp_recorder/delete_embedding")
    async def ws_delete_embedding(hass, connection, msg):
        """Delete a specific embedding by ID.
        
        Can delete either positive (face_embeddings) or negative (negative_embeddings) samples.
        """
        log_to_file(f"INIT: delete_embedding called for id={msg.get('embedding_id')}, type={msg.get('embedding_type')}")
        try:
            embedding_id = int(msg.get("embedding_id"))
            embedding_type = str(msg.get("embedding_type"))
            
            if embedding_type not in ("positive", "negative"):
                connection.send_error(msg["id"], "invalid_type", "Type must be 'positive' or 'negative'")
                return
            
            from .database import get_database
            db = get_database()
            if not db:
                connection.send_error(msg["id"], "db_error", "Database not available")
                return
            
            if embedding_type == "positive":
                success = await hass.async_add_executor_job(db.delete_positive_embedding, embedding_id)
            else:
                success = await hass.async_add_executor_job(db.delete_negative_embedding, embedding_id)
            
            if success:
                log_to_file(f"INIT: Deleted {embedding_type} embedding {embedding_id}")
                connection.send_result(msg["id"], {"success": True, "deleted_id": embedding_id})
            else:
                connection.send_error(msg["id"], "delete_failed", f"Failed to delete embedding {embedding_id}")
            
        except Exception as exc:
            log_to_file(f"INIT: delete_embedding ERROR: {type(exc).__name__}: {exc}")
            connection.send_error(msg["id"], "error", f"{type(exc).__name__}: {exc}")

    websocket_api.async_register_command(hass, ws_delete_embedding)

    # v1.2.0: Get person details with quality scores and outlier detection
    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/get_person_details_quality",
        vol.Required("person_id"): str,
        vol.Optional("outlier_threshold", default=0.65): float,
    })
    @websocket_api.async_response
    async def ws_get_person_details_quality(hass, connection, msg):
        """Get person details with quality scores for each embedding."""
        person_id = msg["person_id"]
        outlier_threshold = msg.get("outlier_threshold", 0.65)
        
        log_to_file(f"INIT: get_person_details_quality called for person_id={person_id}, threshold={outlier_threshold}")
        
        try:
            from .database import get_database
            db = get_database()
            details = await hass.async_add_executor_job(
                db.get_person_details_with_quality, person_id, outlier_threshold
            )

            if details is None:
                connection.send_error(msg["id"], "not_found", f"Person {person_id} not found")
                return
            
            log_to_file(f"INIT: get_person_details_quality returning {details.get('positive_count', 0)} samples, {details.get('outlier_count', 0)} outliers, avg_quality={details.get('avg_quality', 0)}")
            connection.send_result(msg["id"], details)
            
        except Exception as exc:
            log_to_file(f"INIT: get_person_details_quality ERROR: {type(exc).__name__}: {exc}")
            connection.send_error(msg["id"], "error", f"{type(exc).__name__}: {exc}")

    websocket_api.async_register_command(hass, ws_get_person_details_quality)

    # v1.2.0: Bulk delete embeddings
    @websocket_api.websocket_command({
        vol.Required("type"): "rtsp_recorder/bulk_delete_embeddings",
        vol.Required("embedding_ids"): [int],
        vol.Optional("embedding_type", default="positive"): str,
    })
    @websocket_api.async_response
    @limit("rtsp_recorder/bulk_delete_embeddings")
    async def ws_bulk_delete_embeddings(hass, connection, msg):
        """Delete multiple embeddings at once."""
        embedding_ids = msg["embedding_ids"]
        embedding_type = msg.get("embedding_type", "positive")
        
        log_to_file(f"INIT: bulk_delete_embeddings called for {len(embedding_ids)} embeddings, type={embedding_type}")
        
        try:
            from .database import get_database
            db = get_database()
            result = await hass.async_add_executor_job(
                db.bulk_delete_embeddings, embedding_ids, embedding_type
            )

            log_to_file(f"INIT: bulk_delete_embeddings result: {result['success_count']} deleted, {result['failure_count']} failed")
            connection.send_result(msg["id"], result)
            
        except Exception as exc:
            log_to_file(f"INIT: bulk_delete_embeddings ERROR: {type(exc).__name__}: {exc}")
            connection.send_error(msg["id"], "error", f"{type(exc).__name__}: {exc}")

    websocket_api.async_register_command(hass, ws_bulk_delete_embeddings)


