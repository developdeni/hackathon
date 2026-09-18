import unittest

import numpy as np

from backend.app.copernicus import (
    _connected_component,
    _convex_hull,
    _field_candidate_tier,
    _mask_outer_contour,
    _nearest_valid_seed,
    _simplify_hull,
    _touching_edges,
)


class BoundaryGeometryTests(unittest.TestCase):
    def test_connected_component_does_not_cross_gap(self) -> None:
        mask = np.zeros((8, 8), dtype=bool)
        mask[1:4, 1:4] = True
        mask[5:7, 5:7] = True

        component = _connected_component(mask, 2, 2)

        self.assertEqual(int(component.sum()), 9)
        self.assertFalse(component[5, 5])

    def test_nearest_seed_skips_invalid_center(self) -> None:
        valid = np.zeros((9, 9), dtype=bool)
        valid[4, 6] = True

        self.assertEqual(_nearest_valid_seed(valid, 4, 4), (4, 6))

    def test_hull_is_simplified_to_mobile_editable_vertex_count(self) -> None:
        points = [(x, 0) for x in range(20)] + [(19, y) for y in range(20)]
        points += [(x, 19) for x in range(19, -1, -1)] + [(0, y) for y in range(19, -1, -1)]

        hull = _simplify_hull(_convex_hull(points), max_points=14)

        self.assertGreaterEqual(len(hull), 4)
        self.assertLessEqual(len(hull), 14)

    def test_edge_contact_counts_each_image_side(self) -> None:
        component = np.zeros((5, 5), dtype=bool)
        component[0, 2] = True
        component[2, -1] = True

        self.assertEqual(_touching_edges(component), 2)

    def test_outer_contour_preserves_concave_field_edge(self) -> None:
        mask = np.zeros((8, 8), dtype=bool)
        mask[1:7, 1:4] = True
        mask[4:7, 4:7] = True

        contour = _mask_outer_contour(mask)

        self.assertIn((3.5, 3.5), contour)
        self.assertGreater(len(contour), 8)

    def test_multi_hectare_compact_candidate_is_accepted(self) -> None:
        tier = _field_candidate_tier(
            pixel_count=1106,
            area_ha=5.9,
            compactness=0.54,
            area_ratio=0.017,
            touching_edges=0,
        )

        self.assertEqual(tier, "confident")

    def test_fragmented_settlement_candidate_is_rejected(self) -> None:
        tier = _field_candidate_tier(
            pixel_count=7094,
            area_ha=43.8,
            compactness=0.02,
            area_ratio=0.108,
            touching_edges=0,
        )

        self.assertIsNone(tier)


if __name__ == "__main__":
    unittest.main()
