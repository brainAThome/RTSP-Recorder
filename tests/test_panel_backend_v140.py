"""Tests for the v1.4.0 panel backend additions.

Covers:
* camera_settings.list_cameras() — the new full-camera-list helper used by the
  panel's Per-Camera and Delete tabs (the riskiest new pure logic).
* The data/options mutation semantics behind ws_set_global_settings (mirrors how
  the closure builds new_data/new_options).

The WS handlers themselves are thin closures over a ConfigEntry; their whitelist
and path validation are additionally verified live against the real HA WS API at
deploy time.

Run: PYTHONPATH=custom_components/rtsp_recorder pytest tests/test_panel_backend_v140.py
"""
import importlib

cs = importlib.import_module("camera_settings")


class TestListCameras:
    def test_lists_cameras_from_base_keys(self):
        cfg = {
            "duration_Garten_vorne": 90,
            "sensors_Garten_vorne": ["binary_sensor.x"],
            "rtsp_url_Wohnzimmer": "rtsp://example",
            "duration_Wohnzimmer": 120,
        }
        assert cs.list_cameras(cfg) == ["Garten_vorne", "Wohnzimmer"]

    def test_dedups_camera_with_multiple_base_keys(self):
        cfg = {
            "sensors_Cam": ["binary_sensor.a"],
            "duration_Cam": 60,
            "snapshot_delay_Cam": 3,
            "rtsp_url_Cam": "rtsp://x",
            "retention_hours_Cam": 5,
        }
        assert cs.list_cameras(cfg) == ["Cam"]

    def test_legacy_single_sensor_key(self):
        cfg = {"sensor_Tuer": "binary_sensor.legacy"}
        assert cs.list_cameras(cfg) == ["Tuer"]

    def test_ignores_global_keys(self):
        cfg = {
            "analysis_detector_confidence": 0.4,
            "analysis_objects": ["person"],
            "storage_path": "/media/x",
            "snapshot_path": "/config/www/thumbnails",
            "retention_days": 7,
            "retention_hours": 0,          # global (no trailing suffix)
            "cleanup_interval_hours": 24,
        }
        assert cs.list_cameras(cfg) == []

    def test_analysis_override_only_camera_is_NOT_listed(self):
        # A camera that only has an analysis override (no base key) must not be
        # detected — a stale override must never resurrect a deleted camera.
        cfg = {"detector_confidence_Ghost": 0.1, "frame_interval_Ghost": 5}
        assert cs.list_cameras(cfg) == []

    def test_sensors_prefix_not_swallowed_by_legacy_sensor_prefix(self):
        # "sensors_X" must yield suffix "X", not be mis-split by the "sensor_" prefix.
        cfg = {"sensors_Garten_vorne": ["binary_sensor.x"]}
        assert cs.list_cameras(cfg) == ["Garten_vorne"]

    def test_empty_config(self):
        assert cs.list_cameras({}) == []

    def test_accepts_dict_keys_iterable(self):
        cfg = {"duration_A": 1, "duration_B": 2}
        assert cs.list_cameras(cfg.keys()) == ["A", "B"]

    def test_camera_keys_match_set_camera_setting_roundtrip(self):
        # The suffix returned by list_cameras is exactly what set_camera_setting/
        # delete_camera use internally (camera_key is idempotent on a suffix).
        cfg = {"duration_Garten_vorne": 90}
        (key,) = cs.list_cameras(cfg)
        assert cs.camera_key(key) == key  # idempotent
        # and a per-camera override written for that key resolves back
        data = {"analysis_detector_confidence": 0.4}
        cs.set_override(data, "analysis_detector_confidence", key, 0.2)
        assert data[f"detector_confidence_{key}"] == 0.2


class TestSetGlobalSettingsSemantics:
    """Mirrors ws_set_global_settings: write whitelisted globals into BOTH dicts."""

    def test_global_update_writes_both_dicts(self):
        updates = {"analysis_detector_confidence": 0.6, "analysis_enabled": True}
        data = {"analysis_detector_confidence": 0.4}
        options = {}
        new_data = dict(data)
        new_options = dict(options)
        new_data.update(updates)
        new_options.update(updates)
        assert new_data["analysis_detector_confidence"] == 0.6
        assert new_options["analysis_detector_confidence"] == 0.6
        assert new_options["analysis_enabled"] is True
        # merged config (what reads see) reflects the new global
        merged = {**new_data, **new_options}
        assert merged["analysis_detector_confidence"] == 0.6

class TestCameraBaseFields:
    """camera_settings.read_camera_base / set_camera_base (recording settings)."""

    def test_read_base_returns_form_fields(self):
        cfg = {
            "sensors_Garten_vorne": ["binary_sensor.x"],
            "duration_Garten_vorne": 90,
            "snapshot_delay_Garten_vorne": 3,
            "rtsp_url_Garten_vorne": "rtsp://cam",
            "retention_hours_Garten_vorne": 12.0,
        }
        base = cs.read_camera_base(cfg, "Garten vorne")
        assert base == {
            "motion_sensors": ["binary_sensor.x"],
            "recording_duration": 90,
            "snapshot_delay": 3,
            "rtsp_url": "rtsp://cam",
            "camera_retention": 12.0,
            # Ohne gespeicherten enabled_-Key gilt die Kamera als aktiv.
            "camera_enabled": True,
        }

    def test_read_base_reports_disabled_camera(self):
        cfg = {"duration_Tuer": 60, "enabled_Tuer": False}
        assert cs.read_camera_base(cfg, "Tuer")["camera_enabled"] is False

    def test_enabled_default_true_without_key(self):
        assert cs.is_camera_enabled({}, "Garten vorne") is True
        assert cs.is_camera_enabled_suffix({}, "Garten_vorne") is True

    def test_enabled_false_only_for_explicit_false(self):
        assert cs.is_camera_enabled({"enabled_Garten_vorne": False}, "Garten vorne") is False
        # Truthy-Werte gelten weiterhin als aktiv
        assert cs.is_camera_enabled({"enabled_Garten_vorne": True}, "Garten vorne") is True

    def test_set_base_enabled_true_removes_key(self):
        data, options = {"enabled_Tuer": False}, {"enabled_Tuer": False}
        touched = cs.set_camera_base(data, options, "Tuer", {"camera_enabled": True})
        assert "enabled_Tuer" in touched
        assert "enabled_Tuer" not in data and "enabled_Tuer" not in options

    def test_set_base_enabled_false_persists(self):
        data, options = {}, {}
        cs.set_camera_base(data, options, "Tuer", {"camera_enabled": False})
        assert data["enabled_Tuer"] is False and options["enabled_Tuer"] is False

    def test_delete_camera_removes_enabled_key(self):
        data = {"duration_Tuer": 60, "enabled_Tuer": False}
        options = dict(data)
        removed = cs.delete_camera(data, options, "Tuer")
        assert "enabled_Tuer" in removed
        assert "enabled_Tuer" not in data and "enabled_Tuer" not in options

    def test_enabled_key_alone_does_not_create_camera(self):
        # Ein uebriggebliebener enabled_-Key darf keine geloeschte Kamera wiederbeleben.
        assert cs.list_cameras({"enabled_Geist"}) == []

    def test_read_base_legacy_single_sensor_fallback(self):
        cfg = {"sensor_Tuer": "binary_sensor.legacy", "duration_Tuer": 60}
        base = cs.read_camera_base(cfg, "Tuer")
        assert base["motion_sensors"] == ["binary_sensor.legacy"]
        assert base["recording_duration"] == 60

    def test_set_base_writes_both_dicts_mirrors_form(self):
        data, options = {}, {}
        touched = cs.set_camera_base(data, options, "Neu Cam", {
            "motion_sensors": ["binary_sensor.a"],
            "recording_duration": 120,
            "snapshot_delay": 0,
            "rtsp_url": "rtsp://x",
            "camera_retention": 0,   # 0 => use global => key removed
        })
        assert data["sensors_Neu_Cam"] == ["binary_sensor.a"]
        assert data["duration_Neu_Cam"] == 120
        assert data["snapshot_delay_Neu_Cam"] == 0
        assert data["rtsp_url_Neu_Cam"] == "rtsp://x"
        assert "retention_hours_Neu_Cam" not in data       # 0 not stored
        assert options["duration_Neu_Cam"] == 120          # written to both
        assert "duration_Neu_Cam" in touched

    def test_set_base_empty_sensors_and_url_remove_keys(self):
        data = {"sensors_Cam": ["binary_sensor.old"], "rtsp_url_Cam": "rtsp://old"}
        options = dict(data)
        cs.set_camera_base(data, options, "Cam", {"motion_sensors": [], "rtsp_url": ""})
        assert "sensors_Cam" not in data and "sensors_Cam" not in options
        assert "rtsp_url_Cam" not in data and "rtsp_url_Cam" not in options

    def test_set_base_retention_positive_stored(self):
        data, options = {}, {}
        cs.set_camera_base(data, options, "Cam", {"camera_retention": 5.5})
        assert data["retention_hours_Cam"] == 5.5

    def test_add_camera_dup_check_uses_base_prefixes(self):
        # mirrors ws_add_camera duplicate detection
        cfg = {"duration_Garten_vorne": 90}
        safe = cs.camera_key("Garten vorne")
        assert any(f"{p}{safe}" in cfg for p in cs.CAMERA_BASE_PREFIXES)
        assert not any(f"{p}{cs.camera_key('Ganz Neu')}" in cfg for p in cs.CAMERA_BASE_PREFIXES)


class TestGlobalSettingsExtra:
    def test_global_change_does_not_touch_per_camera_override(self):
        # Changing a global must leave an existing per-camera override intact.
        updates = {"analysis_detector_confidence": 0.6}
        data = {
            "analysis_detector_confidence": 0.4,
            "detector_confidence_Garten_vorne": 0.1,
        }
        new_data = dict(data)
        new_data.update(updates)
        assert new_data["detector_confidence_Garten_vorne"] == 0.1
        # the per-camera value still wins on resolve
        assert cs.resolve(new_data, "analysis_detector_confidence", "Garten vorne") == 0.1
