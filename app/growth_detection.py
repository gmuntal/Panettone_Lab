"""Future growth-analysis seam. v0.1 records images; it does not infer growth yet."""

from typing import Protocol


class GrowthAnalyzer(Protocol):
    def analyze(self, image_path: str) -> dict:
        """Return score, detected flag, and diagnostic metadata for a captured frame."""
        ...


class NoopGrowthAnalyzer:
    def analyze(self, image_path: str) -> dict:
        return {"growth_score": None, "growth_detected": None, "analysis_json": None}
