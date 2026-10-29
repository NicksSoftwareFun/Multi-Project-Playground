// Shared constants. Loaded by the page hook (MAIN world), the content script,
// the background service worker (importScripts) and the popup.
(function (root) {
  'use strict';

  const SERVICE_URL =
    'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/' +
    'ACS_Population_by_Race_and_Hispanic_Origin_Boundaries/FeatureServer';

  // Same fields, labels, colors and draw order as the Esri web map
  // "Race in the US by Dot Density" (item 71df79b33d4e4db28c915a9f16c3074e).
  const RACES = [
    { field: 'B03002_003E', label: 'White (non-Hispanic)', color: [179, 212, 255] },
    { field: 'B03002_012E', label: 'Hispanic or Latino', color: [220, 10, 180] },
    { field: 'B03002_004E', label: 'Black', color: [255, 163, 0] },
    { field: 'B03002_006E', label: 'Asian', color: [155, 25, 245] },
    { field: 'B03002_005E', label: 'American Indian / Alaska Native', color: [230, 216, 0] },
    { field: 'B03002_009E', label: 'Two or more races', color: [80, 233, 145] },
    { field: 'B03002_007E', label: 'Native Hawaiian / Pacific Islander', color: [11, 180, 255] },
    { field: 'B03002_008E', label: 'Some other race', color: [230, 0, 73] },
  ];

  // Geography levels. dotValue is people-per-dot at REFERENCE_ZOOM, taken
  // from the web map's renderers. queryZoom is the tile grid used to fetch
  // and cache features; maxAllowableOffset (degrees) generalizes geometry.
  // nameFields differ per layer (only tracts carry County, states have none).
  const LEVELS = {
    state: { layer: 0, dotValue: 124, minZoom: 0, queryZoom: 0, maxAllowableOffset: 0.01, nameFields: ['NAME'], label: 'State' },
    county: { layer: 1, dotValue: 30, minZoom: 6, queryZoom: 6, maxAllowableOffset: 0.0008, nameFields: ['NAME', 'State'], label: 'County' },
    tract: { layer: 2, dotValue: 36, minZoom: 10, queryZoom: 10, maxAllowableOffset: 0.00003, nameFields: ['NAME', 'County', 'State'], label: 'Census tract' },
  };

  // Map scale 1:577,790 (the renderers' referenceScale) is web-map zoom 10.
  const REFERENCE_ZOOM = 10;

  const DEFAULT_SETTINGS = {
    enabled: true,
    opacity: 0.9, // 0..1, dot layer opacity
    dim: 0, // 0..1, darkens the basemap under the dots so pale colors read
    dotSize: 0, // px; 0 = auto by zoom
    dotValue: 0, // people per dot; 0 = auto by zoom
    level: 'auto', // 'auto' | 'state' | 'county' | 'tract'
    outlines: false,
    legend: false,
    hidden: [], // race fields switched off
  };

  root.ZRO_CONFIG = Object.freeze({
    SERVICE_URL,
    RACES,
    LEVELS,
    REFERENCE_ZOOM,
    DEFAULT_SETTINGS,
  });
})(typeof self !== 'undefined' ? self : window);
