"""Lightweight, calibratable image analysis for starter height in a clear jar.

This estimates the visible fill height inside a fixed camera region. It does not
measure mass or volume and intentionally reports low-confidence frames as
unavailable instead of manufacturing a measurement.
"""

import json
import math
DEFAULT_ROI = {"x0": 0.36, "y0": 0.32, "x1": 0.58, "y1": 0.95}
DETECTOR_VERSION = 2
INITIAL_MAX_HEIGHT_RATIO = 0.55
TRACKING_TOLERANCE = 0.18


def growth_from_surface(bottom_y, initial_surface_y, current_surface_y):
    """Return height factor and percent growth from normalized image coordinates."""
    try:
        bottom_y, initial_surface_y, current_surface_y = map(
            float, (bottom_y, initial_surface_y, current_surface_y))
    except (TypeError, ValueError):
        return None
    initial_height = bottom_y - initial_surface_y
    current_height = bottom_y - current_surface_y
    if (not all(map(math.isfinite, (bottom_y, initial_surface_y, current_surface_y))) or
            initial_height <= 0 or current_height <= 0):
        return None
    factor = current_height / initial_height
    return {"factor": round(factor, 3), "percent": round((factor - 1) * 100, 1)}


def _otsu_threshold(histogram):
    total = sum(histogram)
    if not total:
        return 128
    total_sum = sum(index * count for index, count in enumerate(histogram))
    background_sum = 0
    background_weight = 0
    best_variance = -1
    threshold = 128
    for value, count in enumerate(histogram):
        background_weight += count
        if background_weight == 0:
            continue
        foreground_weight = total - background_weight
        if foreground_weight == 0:
            break
        background_sum += value * count
        mean_background = background_sum / background_weight
        mean_foreground = (total_sum - background_sum) / foreground_weight
        variance = background_weight * foreground_weight * (mean_background - mean_foreground) ** 2
        if variance > best_variance:
            best_variance = variance
            threshold = value
    # Infrared glare can push Otsu too low in a mostly dark scene.
    return max(96, min(205, threshold))


def _smooth(values, radius=2):
    result = []
    for index in range(len(values)):
        start = max(0, index - radius)
        end = min(len(values), index + radius + 1)
        result.append(sum(values[start:end]) / (end - start))
    return result


def estimate_surface(bright_fractions, previous_ratio=None):
    """Find a plausible, sustained dark-to-bright transition in the jar."""
    count = len(bright_fractions)
    smoothed = _smooth(bright_fractions)
    if count < 32:
        return None

    best = None
    for row in range(14, count - 14):
        height_ratio = (count - row) / count
        if previous_ratio is None:
            # A shelf or reflection above the starter can look like a surface.
            # The first frame should be plausible for a starter resting at the
            # bottom of the jar; later frames follow the previous measurement.
            if height_ratio > INITIAL_MAX_HEIGHT_RATIO:
                continue
        elif abs(height_ratio - previous_ratio) > TRACKING_TOLERANCE:
            continue
        above = sum(smoothed[row - 14:row - 3]) / 11
        below = sum(smoothed[row + 3:row + 14]) / 11
        contrast = below - above
        if below < 0.55 or above > 0.62 or contrast < 0.18:
            continue
        confidence = max(0.0, min(1.0, contrast * 2.2))
        # Follow the nearest plausible surface across frames. For the first
        # frame, keep the strongest transition in the lower part of the jar.
        continuity = -abs(height_ratio - previous_ratio) if previous_ratio is not None else 0
        candidate = (continuity, contrast, -row, row, confidence, above, below)
        if best is None or candidate[:2] > best[:2]:
            best = candidate

    if best is None or best[4] < 0.35:
        return None
    row = best[3]
    # Normalized fill height: 0 is empty at ROI bottom; 1 reaches its top.
    return {
        "height_ratio": round((count - row) / count, 4),
        "confidence": round(best[4], 3),
        "surface_row_ratio": round(row / count, 4),
        "contrast": round(best[1], 3),
    }


def analyze_image(image_path, roi=None, previous_ratio=None):
    """Analyze an image and return fields that fit the photos database row."""
    from PIL import Image

    roi = roi or DEFAULT_ROI
    with Image.open(image_path) as source:
        image = source.convert("L")
        # A small, fixed working size keeps the Pi's per-frame CPU cost low.
        width = 320
        height = max(64, round(image.height * width / image.width))
        image = image.resize((width, height), Image.Resampling.BILINEAR)
        left = max(0, min(width - 1, round(float(roi["x0"]) * width)))
        right = max(left + 1, min(width, round(float(roi["x1"]) * width)))
        top = max(0, min(height - 1, round(float(roi["y0"]) * height)))
        bottom = max(top + 1, min(height, round(float(roi["y1"]) * height)))
        # Use the central interior of the selected jar area. This suppresses
        # shelf edges and reflections entering from the sides of a clear pot.
        margin = round((right - left) * 0.20)
        if right - left - 2 * margin >= 24:
            left += margin
            right -= margin
        crop = image.crop((left, top, right, bottom))

    pixels = list(crop.getdata())
    threshold = _otsu_threshold(crop.histogram())
    crop_width, crop_height = crop.size
    fractions = []
    for y in range(crop_height):
        row = pixels[y * crop_width:(y + 1) * crop_width]
        fractions.append(sum(1 for value in row if value >= threshold) / crop_width)

    estimate = estimate_surface(fractions, previous_ratio=previous_ratio)
    if estimate is None:
        details = {"valid": False, "reason": "no_surface_transition", "roi": roi,
                   "detector_version": DETECTOR_VERSION}
        return {"growth_score": None, "growth_detected": None, "analysis_json": json.dumps(details)}

    surface_y = top + round(estimate["surface_row_ratio"] * (bottom - top))
    estimate.update({
        "valid": True,
        "threshold": threshold,
        "surface_y_ratio": round(surface_y / height, 4),
        "roi": roi,
        "detector_version": DETECTOR_VERSION,
    })
    return {
        "growth_score": estimate["height_ratio"],
        "growth_detected": None,
        "analysis_json": json.dumps(estimate, separators=(",", ":")),
    }
