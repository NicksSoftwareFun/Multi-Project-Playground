"""Offline unit tests for the pure helpers (run with: python -m unittest discover tests)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from supercell_wx_mcp.util import (  # noqa: E402
    LEVEL3_PRODUCT_CODES,
    haversine_km,
    normalize_site_l2,
    normalize_site_l3,
    parse_level3_key,
    parse_s3_listing,
)

SAMPLE_S3_XML = """<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>noaa-nexrad-level2</Name>
  <Prefix>2026/08/11/KTLX/</Prefix>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>token123</NextContinuationToken>
  <Contents>
    <Key>2026/08/11/KTLX/KTLX20260811_000217_V06</Key>
    <LastModified>2026-08-11T00:09:12.000Z</LastModified>
    <Size>5242880</Size>
  </Contents>
  <Contents>
    <Key>2026/08/11/KTLX/KTLX20260811_000217_V06_MDM</Key>
    <LastModified>2026-08-11T00:09:13.000Z</LastModified>
    <Size>1024</Size>
  </Contents>
  <CommonPrefixes>
    <Prefix>2026/08/11/KTLX/sub/</Prefix>
  </CommonPrefixes>
</ListBucketResult>
"""


class TestSiteNormalization(unittest.TestCase):
    def test_level2_uppercases_and_strips(self):
        self.assertEqual(normalize_site_l2(" ktlx "), "KTLX")

    def test_level3_drops_leading_letter_from_4char_ids(self):
        self.assertEqual(normalize_site_l3("KTLX"), "TLX")
        self.assertEqual(normalize_site_l3("tlx"), "TLX")


class TestHaversine(unittest.TestCase):
    def test_zero_distance(self):
        self.assertAlmostEqual(haversine_km(35.0, -97.0, 35.0, -97.0), 0.0)

    def test_known_distance_okc_to_tulsa(self):
        # OKC (35.47, -97.52) to Tulsa (36.15, -95.99) is roughly 157 km
        d = haversine_km(35.47, -97.52, 36.15, -95.99)
        self.assertTrue(140 < d < 175, f"unexpected distance {d}")


class TestLevel3Key(unittest.TestCase):
    def test_parses_valid_key(self):
        parsed = parse_level3_key("TLX_N0B_2026_08_11_17_32_05")
        self.assertEqual(parsed["site"], "TLX")
        self.assertEqual(parsed["product"], "N0B")
        self.assertEqual(parsed["time"], "2026-08-11T17:32:05Z")

    def test_rejects_malformed_key(self):
        self.assertIsNone(parse_level3_key("not-a-key"))

    def test_product_codes_include_supercell_wx_defaults(self):
        for code in ("N0B", "N0G", "N0C", "N0X", "DVL"):
            self.assertIn(code, LEVEL3_PRODUCT_CODES)


class TestS3Parsing(unittest.TestCase):
    def test_parses_keys_and_pagination(self):
        result = parse_s3_listing(SAMPLE_S3_XML)
        self.assertEqual(len(result["keys"]), 2)
        self.assertEqual(result["keys"][0]["key"], "2026/08/11/KTLX/KTLX20260811_000217_V06")
        self.assertEqual(result["keys"][0]["size_bytes"], 5242880)
        self.assertEqual(result["prefixes"], ["2026/08/11/KTLX/sub/"])
        self.assertTrue(result["is_truncated"])
        self.assertEqual(result["next_continuation_token"], "token123")


if __name__ == "__main__":
    unittest.main()
