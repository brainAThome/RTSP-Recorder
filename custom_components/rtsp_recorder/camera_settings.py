"""Central per-camera settings registry and access helpers.

Feature: Per-camera analysis settings (clean global/per-camera separation).

WHY THIS MODULE EXISTS
----------------------
Before this module, per-camera overrides were handled ad-hoc:
- The config key suffix was built with ``sanitize_camera_key`` (config_flow.py),
- but read back via the on-disk folder name (services.py ``_extract_camera_name_from_path``),
- and a THIRD/FOURTH normaliser existed in the WebSocket layer and the options dropdown.
Only 4 analysis fields had per-camera overrides, the resolve logic was duplicated
across 3 call sites in services.py, and the "0 = use global" sentinel was implicit.

This module is the SINGLE SOURCE OF TRUTH for:
1. which analysis settings can be overridden per camera (``PER_CAMERA_FIELDS``),
2. how a camera name maps to its config-key suffix (``camera_key``),
3. how a per-camera value is resolved with fallback to the global value
   (``resolve``), and
4. how per-camera keys are written / cleared / completely removed
   (``set_override`` / ``clear_override`` / ``collect_camera_keys``).

DESIGN CONSTRAINTS (verified against the codebase, Phase-1 mapping)
------------------------------------------------------------------
* ADDITIVE ONLY. The flat-key schema (``<prefix>_<SafeName>``) is kept exactly as
  it is on disk today, because the integration has no ``async_migrate_entry`` and
  ConfigEntry VERSION is 1. Renaming/nesting keys would silently wipe existing
  camera configs on reload. We therefore reuse the existing key shapes verbatim.
* ONE normaliser. The suffix is produced by ``sanitize_camera_key`` (re-exported
  here as the canonical ``camera_key``) — identical to what config_flow has always
  written, so existing keys keep resolving.
* Sentinel semantics preserved for the 4 legacy threshold/object fields
  ("0 / empty == use global") so existing stored values keep their meaning;
  new boolean/int fields use explicit presence instead (a missing key == global).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable

try:
    from .const import (
        DEFAULT_ANALYSIS_FRAME_INTERVAL,
        DEFAULT_DETECTOR_CONFIDENCE,
        DEFAULT_FACE_CONFIDENCE,
        DEFAULT_FACE_MATCH_THRESHOLD,
        DEFAULT_FACE_MULTISCALE,
        DEFAULT_OVERLAY_SMOOTHING,
    )
except ImportError:  # pragma: no cover - fallback for direct module import in tests
    from const import (
        DEFAULT_ANALYSIS_FRAME_INTERVAL,
        DEFAULT_DETECTOR_CONFIDENCE,
        DEFAULT_FACE_CONFIDENCE,
        DEFAULT_FACE_MATCH_THRESHOLD,
        DEFAULT_FACE_MULTISCALE,
        DEFAULT_OVERLAY_SMOOTHING,
    )


# ===== Canonical camera-name -> config-key suffix =====
# NOTE: This is intentionally byte-for-byte identical to config_flow.sanitize_camera_key
# so that keys written by the existing config flow continue to resolve. Do NOT "improve"
# this without an async_migrate_entry that rewrites existing keys.
_KEY_STRIP_CHARS = (":", "/", "\\", "?", "*", '"', "<", ">", "|")


def camera_key(name: str) -> str:
    """Return the canonical config-key suffix for a camera name.

    Identical algorithm to ``config_flow.sanitize_camera_key``: drop characters
    outside ``[\\w\\s-]``, strip, turn spaces into underscores, then remove a few
    filesystem-unsafe characters. Kept here as the single canonical implementation
    that read, write and delete paths all share.

    Example: ``"Garten vorne"`` -> ``"Garten_vorne"``.
    """
    clean = re.sub(r"[^\w\s-]", "", name or "").strip().replace(" ", "_")
    for char in _KEY_STRIP_CHARS:
        clean = clean.replace(char, "")
    # Mirror legacy sanitize_camera_key exactly: empty -> "unknown".
    return clean or "unknown"


# ===== Per-camera field registry =====
@dataclass(frozen=True)
class PerCameraField:
    """Describes one analysis setting that can be overridden per camera.

    Attributes:
        global_key: The flat global config key (e.g. ``analysis_detector_confidence``).
        prefix: The per-camera key prefix; the stored key is
            ``f"{prefix}{camera_key(name)}"`` (e.g. ``detector_confidence_Garten_vorne``).
        default: Default used when neither a per-camera nor a global value exists.
        kind: One of ``"float"``, ``"int"``, ``"bool"``, ``"list"``.
        sentinel_zero_is_global: When True (legacy fields), a stored value of 0 / 0.0
            / empty means "fall back to global" and such a value is never written
            (the key is removed instead). New fields use explicit presence instead:
            the key being absent means "use global".
    """

    global_key: str
    prefix: str
    default: Any
    kind: str
    sentinel_zero_is_global: bool = False

    def key_for(self, camera: str) -> str:
        """Return the per-camera config key for ``camera``."""
        return f"{self.prefix}{camera_key(camera)}"


# The 4 legacy per-camera fields keep their exact prefixes and 0/empty=global
# semantics (existing stored values must keep working). The 4 new fields use
# explicit presence (absent key = use global) which avoids the ambiguous-zero bug.
PER_CAMERA_FIELDS: tuple[PerCameraField, ...] = (
    # --- legacy (already had per-camera overrides) ---
    PerCameraField("analysis_objects", "analysis_objects_", ["person"], "list"),
    PerCameraField("analysis_detector_confidence", "detector_confidence_",
                   DEFAULT_DETECTOR_CONFIDENCE, "float", sentinel_zero_is_global=True),
    PerCameraField("analysis_face_confidence", "face_confidence_",
                   DEFAULT_FACE_CONFIDENCE, "float", sentinel_zero_is_global=True),
    PerCameraField("analysis_face_match_threshold", "face_match_threshold_",
                   DEFAULT_FACE_MATCH_THRESHOLD, "float", sentinel_zero_is_global=True),
    # --- new per-camera fields (explicit presence: absent key = use global) ---
    PerCameraField("analysis_frame_interval", "frame_interval_",
                   DEFAULT_ANALYSIS_FRAME_INTERVAL, "int"),
    PerCameraField("analysis_face_enabled", "face_enabled_", False, "bool"),
    PerCameraField("analysis_face_multiscale", "face_multiscale_",
                   DEFAULT_FACE_MULTISCALE, "bool"),
    PerCameraField("analysis_overlay_smoothing", "overlay_smoothing_",
                   DEFAULT_OVERLAY_SMOOTHING, "bool"),
)

# All per-camera key prefixes that belong to a camera and must be removed when a
# camera is deleted. Includes the non-analysis base keys plus the analysis overrides.
# Order/content verified against config_flow.py:302-369 and the Phase-1 mapping.
CAMERA_BASE_PREFIXES: tuple[str, ...] = (
    "sensors_",
    "sensor_",            # legacy single-sensor
    "duration_",
    "snapshot_delay_",
    "rtsp_url_",
    "retention_hours_",
)

ALL_CAMERA_PREFIXES: tuple[str, ...] = CAMERA_BASE_PREFIXES + ("enabled_",) + tuple(
    f.prefix for f in PER_CAMERA_FIELDS
)

_FIELD_BY_GLOBAL_KEY = {f.global_key: f for f in PER_CAMERA_FIELDS}


def get_field(global_key: str) -> PerCameraField | None:
    """Return the :class:`PerCameraField` for a global key, or None."""
    return _FIELD_BY_GLOBAL_KEY.get(global_key)


# Non-analysis per-camera RECORDING settings (what the old config_flow's
# camera_config / manual_camera steps wrote). Maps the panel form-field name to
# (stored-key prefix, value kind). Mirrors config_flow.py exactly so the panel
# writes the same keys the recorder already reads.
CAMERA_BASE_FIELDS: dict[str, tuple[str, str]] = {
    "motion_sensors": ("sensors_", "list"),
    "recording_duration": ("duration_", "int"),
    "snapshot_delay": ("snapshot_delay_", "int"),
    "rtsp_url": ("rtsp_url_", "str"),
    "camera_retention": ("retention_hours_", "float"),
    # Abwesenheit des Keys == Kamera aktiv. Nur der Aus-Zustand wird gespeichert,
    # damit bestehende Konfigurationen ohne Migration aktiv bleiben.
    "camera_enabled": ("enabled_", "bool"),
}


def read_camera_base(config: dict, camera: str) -> dict[str, Any]:
    """Return the stored base recording settings for ``camera`` (form-field keyed)."""
    safe = camera_key(camera)
    out: dict[str, Any] = {}
    for field, (prefix, _kind) in CAMERA_BASE_FIELDS.items():
        key = f"{prefix}{safe}"
        if key in config:
            out[field] = config[key]
    if "motion_sensors" not in out:  # legacy single-sensor fallback
        legacy = config.get(f"sensor_{safe}")
        if legacy:
            out["motion_sensors"] = [legacy] if isinstance(legacy, str) else legacy
    # Immer einen expliziten Wert liefern, damit die Karte den Schalter korrekt
    # vorbelegt: fehlender Key == aktiv.
    out["camera_enabled"] = is_camera_enabled_suffix(config, safe)
    return out


def is_camera_enabled_suffix(config: dict, suffix: str) -> bool:
    """True, solange die Kamera nicht ausdruecklich deaktiviert wurde.

    ``suffix`` ist der bereits normalisierte Key-Suffix (z. B. ``Garten_vorne``),
    wie ihn die Auto-Record-Registrierung aus den Config-Keys ableitet.
    """
    return config.get(f"enabled_{suffix}", True) is not False


def is_camera_enabled(config: dict, camera: str) -> bool:
    """True, solange die Kamera nicht ausdruecklich deaktiviert wurde."""
    return is_camera_enabled_suffix(config, camera_key(camera))


def set_camera_base(data: dict, options: dict, camera: str, fields: dict) -> list[str]:
    """Write the provided base recording settings into BOTH dicts (in place).

    Mirrors config_flow.py semantics: empty list/url removes the key; retention
    <= 0 removes the key (0 == use global); duration/delay are stored as ints.
    Returns the list of touched keys. Unknown ``fields`` entries are ignored.
    """
    safe = camera_key(camera)
    touched: list[str] = []
    for field, value in fields.items():
        spec = CAMERA_BASE_FIELDS.get(field)
        if spec is None:
            continue
        prefix, kind = spec
        key = f"{prefix}{safe}"
        for store in (data, options):
            if kind in ("list", "str"):
                if value:
                    store[key] = value
                else:
                    store.pop(key, None)
            elif kind == "int":
                store[key] = int(value)
            elif kind == "float":
                fv = float(value)
                if fv > 0:
                    store[key] = fv
                else:
                    store.pop(key, None)
            elif kind == "bool":
                # True == Default (aktiv) -> Key entfernen; nur False wird persistiert.
                if value:
                    store.pop(key, None)
                else:
                    store[key] = False
        touched.append(key)
    return touched


def list_cameras(config: Iterable[str]) -> list[str]:
    """Return the sorted camera key-suffixes that have at least one BASE config key.

    A camera counts as "configured" when it has a base key (``sensors_``,
    ``rtsp_url_``, ``duration_`` ...). Analysis-only override keys are deliberately
    NOT used to detect a camera, so a stale override cannot resurrect a deleted one.
    Every camera created via the config flow has a ``duration_<suffix>`` key, so
    this reliably enumerates all configured cameras. ``config`` may be any iterable
    of key names (e.g. ``dict.keys()``).
    """
    suffixes: set[str] = set()
    for key in config:
        for prefix in CAMERA_BASE_PREFIXES:
            if key.startswith(prefix):
                suffix = key[len(prefix):]
                if suffix:
                    suffixes.add(suffix)
                break
    return sorted(suffixes)


# ===== Resolution (read with per-camera -> global fallback) =====
def _is_unset(value: Any, field: PerCameraField) -> bool:
    """Return True if ``value`` should be treated as 'not overridden'."""
    if value is None:
        return True
    if field.kind == "list":
        return not value  # empty list / empty == use global
    if field.sentinel_zero_is_global:
        try:
            return float(value) <= 0
        except (TypeError, ValueError):
            return True
    return False


def _coerce(value: Any, field: PerCameraField) -> Any:
    """Coerce a raw stored value to the field's declared type."""
    if field.kind == "int":
        return int(value)
    if field.kind == "float":
        return float(value)
    if field.kind == "bool":
        return bool(value)
    return value  # list / passthrough


def resolve(config: dict, global_key: str, camera: str) -> Any:
    """Resolve the effective value of ``global_key`` for ``camera``.

    Lookup order: per-camera override (if set) -> global value -> field default.
    ``config`` is the merged ``{**entry.data, **entry.options}`` dict.
    """
    field = _FIELD_BY_GLOBAL_KEY.get(global_key)
    if field is None:
        # Not a per-camera field: just return the global value.
        return config.get(global_key)

    cam_val = config.get(field.key_for(camera))
    if not _is_unset(cam_val, field):
        return _coerce(cam_val, field)

    glob_val = config.get(global_key)
    if glob_val is not None and not (field.kind == "list" and not glob_val):
        return _coerce(glob_val, field)

    return field.default


def resolve_all(config: dict, camera: str) -> dict[str, Any]:
    """Resolve every per-camera-capable field for ``camera`` into a dict keyed by global_key."""
    return {f.global_key: resolve(config, f.global_key, camera) for f in PER_CAMERA_FIELDS}


def camera_overrides(config: dict, camera: str) -> dict[str, Any]:
    """Return only the per-camera fields that ARE overridden for ``camera`` (raw stored values)."""
    out: dict[str, Any] = {}
    for f in PER_CAMERA_FIELDS:
        raw = config.get(f.key_for(camera))
        if not _is_unset(raw, f):
            out[f.global_key] = _coerce(raw, f)
    return out


# ===== Mutation helpers (operate on a plain dict; caller persists) =====
def set_override(target: dict, global_key: str, camera: str, value: Any) -> None:
    """Set or clear a per-camera override in ``target`` (a config dict).

    If ``value`` represents "use global" (None, empty list, or 0 for legacy
    zero-sentinel fields), the override key is removed instead of stored, so the
    camera falls back to the global value.
    """
    field = _FIELD_BY_GLOBAL_KEY.get(global_key)
    if field is None:
        raise KeyError(f"{global_key} is not a per-camera field")
    key = field.key_for(camera)
    if _is_unset(value, field):
        target.pop(key, None)
        return
    target[key] = _coerce(value, field)


def clear_override(target: dict, global_key: str, camera: str) -> None:
    """Remove a single per-camera override (camera then uses the global value)."""
    field = _FIELD_BY_GLOBAL_KEY.get(global_key)
    if field is None:
        raise KeyError(f"{global_key} is not a per-camera field")
    target.pop(field.key_for(camera), None)


def collect_camera_keys(config: Iterable[str], camera: str) -> list[str]:
    """Return every config key that belongs to ``camera`` (for deletion).

    Matches all known per-camera prefixes against the camera's canonical suffix.
    ``config`` may be any iterable of key names (e.g. ``dict.keys()``).
    """
    suffix = camera_key(camera)
    targets = {f"{p}{suffix}" for p in ALL_CAMERA_PREFIXES}
    return [k for k in config if k in targets]


def delete_camera(data: dict, options: dict, camera: str) -> list[str]:
    """Remove all keys for ``camera`` from BOTH dicts in place; return removed keys.

    Both ``entry.data`` and ``entry.options`` must be cleaned because the same key
    may live in either (Phase-1 risk: data/options duality). Returns the sorted
    list of removed keys for logging/verification.
    """
    removed: set[str] = set()
    for store in (data, options):
        for key in collect_camera_keys(list(store.keys()), camera):
            store.pop(key, None)
            removed.add(key)
    return sorted(removed)
