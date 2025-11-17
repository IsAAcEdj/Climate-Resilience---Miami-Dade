import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import mapboxgl from 'https://cdn.skypack.dev/mapbox-gl@2.15.0';


const parseNumericValue = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const cleaned = String(value).replace(/[^0-9eE.+-]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
};

const toWgs84Coordinate = ([x, y]) => {
  const originShift = 20037508.34;
  const lon = (x / originShift) * 180;
  let lat = (y / originShift) * 180;
  lat = (180 / Math.PI) * (2 * Math.atan(Math.exp((lat * Math.PI) / 180)) - Math.PI / 2);
  return [lon, lat];
};

const transformToWgs84 = (coords) => {
  if (!Array.isArray(coords)) return coords;
  if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    return toWgs84Coordinate(coords);
  }
  return coords.map(transformToWgs84);
};

const walkCoordinates = (geometry, callback) => {
  if (!geometry || !geometry.coordinates) return;
  const traverse = (coords) => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      callback(coords);
      return;
    }
    coords.forEach(traverse);
  };
  traverse(geometry.coordinates);
};

const reprojectFeatureCollectionIfNeeded = (featureCollection) => {
  if (!featureCollection?.features?.length) return featureCollection;
  let firstCoord = null;
  for (const feature of featureCollection.features) {
    if (!feature?.geometry) continue;
    walkCoordinates(feature.geometry, (coord) => {
      if (!firstCoord) firstCoord = coord;
    });
    if (firstCoord) break;
  }
  if (!firstCoord) return featureCollection;
  const needsReprojection = Math.abs(firstCoord[0]) > 180 || Math.abs(firstCoord[1]) > 90;
  if (!needsReprojection) return featureCollection;
  console.info('[Census] Reprojecting GeoJSON from EPSG:3857 to EPSG:4326');
  return {
    ...featureCollection,
    features: featureCollection.features.map((feature) => {
      if (!feature?.geometry) return feature;
      return {
        ...feature,
        geometry: {
          ...feature.geometry,
          coordinates: transformToWgs84(feature.geometry.coordinates)
        }
      };
    })
  };
};

const getRangeStats = (values) => {
  if (!values.length) return { min: null, mid: null, max: null };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mid = min + (max - min) / 2;
  return { min, mid, max };
};

// Create a small circle polygon around a point to use as a buffer zone
const createCircleBuffer = (center, radiusInMeters = 50) => {
  const [lng, lat] = center;
  const points = 32; // Number of points in the circle
  const circle = [];
  
  for (let i = 0; i <= points; i++) {
    const angle = (i * 360) / points;
    const dx = radiusInMeters * Math.cos((angle * Math.PI) / 180);
    const dy = radiusInMeters * Math.sin((angle * Math.PI) / 180);
    
    // Approximate conversion: 1 degree latitude ≈ 111,000 meters
    // 1 degree longitude ≈ 111,000 * cos(latitude) meters
    const latOffset = dy / 111000;
    const lngOffset = dx / (111000 * Math.cos((lat * Math.PI) / 180));
    
    circle.push([lng + lngOffset, lat + latOffset]);
  }
  
  return circle;
};

const formatWithCommas = (value) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US').format(value);
};

const formatRiskValue = (value) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toFixed(2);
};

const App = () => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const districtsRef = useRef({});
  const censusDataRef = useRef(null);
  const hoveredCensusIdRef = useRef(null);
  const censusStatsRef = useRef(null);
  const censusViewRef = useRef('risk');
  const pred3PEDataRef = useRef({}); // Mapping of GEOID to PRED3_PE values
  const isHoveringMarkerRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [allMarkers, setAllMarkers] = useState([]);
  const [currentDistrict, setCurrentDistrict] = useState(null);
  const [allProjectsData, setAllProjectsData] = useState(null);
  const [isSatelliteView, setIsSatelliteView] = useState(false);
  const [activeFeature, setActiveFeature] = useState(null);
  const [censusStats, setCensusStats] = useState(null);
  const [censusLayersReady, setCensusLayersReady] = useState(false);
  const [activeCensusView, setActiveCensusView] = useState('risk');
  const [censusVisible, setCensusVisible] = useState(true);
  const censusEventsBoundRef = useRef(false);
  const censusVisibleRef = useRef(true);

  const handleCensusViewChange = (view) => {
    censusViewRef.current = view;
    setActiveCensusView(view);
  };

  const handleCensusVisibilityToggle = () => {
    setCensusVisible((prev) => !prev);
  };

  // Define district boundaries
  

  // Get marker color based on project type
  const getMarkerColor = (projectType) => {
    switch(projectType) {
      case 'Green Infrastructure':
        return '#e74c3c';
      case 'Grey Infrastructure':
        return '#3498db';
      default:
        return '#95a5a6';
    }
  };

  // Get marker size based on project cost
  const getMarkerSize = (cost) => {
    if (!cost) return 8;
    const numericCost = parseFloat(cost.replace(/[$,]/g, ''));
    if (numericCost > 50000000) return 15;
    if (numericCost > 10000000) return 12;
    return 8;
  };


  

  // Check if point is within district
  const isPointInDistrict = (point, districtCoords) => {
    const [lng, lat] = point;
    let inside = false;
    
    for (let i = 0, j = districtCoords.length - 1; i < districtCoords.length; j = i++) {
      const [xi, yi] = districtCoords[i];
      const [xj, yj] = districtCoords[j];
      
      const intersect = ((yi > lat) !== (yj > lat)) &&
          (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    
    return inside;
  };

  // Zoom to district
  const zoomToDistrict = (districtId) => {
    const district = districtsRef.current[districtId];
    if (!district || !map.current) return;

    setCurrentDistrict(districtId);
    console.log(district.zoom);
    map.current.flyTo({
      center: district.center,
      zoom: district.zoom,
      duration: 1500
    });

    Object.keys(districtsRef.current).forEach(id => {
      map.current.setPaintProperty(
        `${id}-fill`,
        'fill-opacity',
        id === districtId ? 0.3 : 0.1
      );
      map.current.setPaintProperty(
        `${id}-outline`,
        'line-opacity',
        id === districtId ? 1 : 0.5
      );
      map.current.setPaintProperty(
        `${id}-outline`,
        'line-width',
        id === districtId ? 3 : 2
      );
    });

    allMarkers.forEach(marker => {
      const coords = marker.getLngLat();
      const pointInDistrict = isPointInDistrict(
        [coords.lng, coords.lat],
        district.coordinates
      );

      if (pointInDistrict) {
        marker.getElement().style.opacity = '1';
        marker.getElement().style.transform = 'scale(1.3)';
        marker.getElement().style.zIndex = '1000';
      } else {
        marker.getElement().style.opacity = '0.3';
        marker.getElement().style.transform = 'scale(0.8)';
        marker.getElement().style.zIndex = '1';
      }
    });
  };

  // Reset view
  const resetView = () => {
    if (!map.current) return;
    
    setCurrentDistrict(null);
    handleCensusViewChange('risk');

    Object.keys(districtsRef.current).forEach(id => {
      map.current.setPaintProperty(`${id}-fill`, 'fill-opacity', 0.1);
      map.current.setPaintProperty(`${id}-outline`, 'line-opacity', 0.5);
      map.current.setPaintProperty(`${id}-outline`, 'line-width', 2);
    });

    allMarkers.forEach(marker => {
      marker.getElement().style.opacity = '1';
      marker.getElement().style.transform = 'scale(1)';
      marker.getElement().style.zIndex = '1';
    });

    map.current.flyTo({
      center: [-80.6327, 25.5516],
      zoom: 11,
      duration: 1500
    });
  };




  const addCensusSourceAndLayers = useCallback(() => {
    if (!map.current || !censusDataRef.current) return;

    const stats = censusStatsRef.current;
    const view = censusViewRef.current;

    if (!stats) return;

    // Color mapping for FEMA Risk Ratings - More distinctive colors
    const riskRatingColors = {
      'Very Low': '#4CAF50',           // Bright Green
      'Relatively Low': '#8BC34A',    // Lime Green
      'Relatively Moderate': '#FFC107', // Amber/Yellow
      'Relatively High': '#FF6F00',    // Red-Orange
      'Very High': '#B71C1C'           // Dark Red
    };

    // Build color expression based on risk rating strings
    const buildRiskRatingColorExpression = () => {
      const cases = [];
      Object.entries(riskRatingColors).forEach(([rating, color]) => {
        cases.push(['==', ['get', '__riskRating'], rating], color);
      });
      // Default color for missing or unknown ratings
      cases.push('#9e9e9e'); // Gray
      
      return ['case', ...cases];
    };

    const riskColorExpression = buildRiskRatingColorExpression();
    
    // Build color expression for PRED3_PE (percentage values)
    const buildPred3PEColorExpression = () => {
      const pred3PEStats = stats.pred3PE;
      if (!pred3PEStats || pred3PEStats.min === null || pred3PEStats.max === null) {
        return [
          'case',
          ['==', ['typeof', ['get', '__pred3PE']], 'number'],
          '#9e9e9e',
          '#9e9e9e'
        ];
      }
      if (pred3PEStats.min === pred3PEStats.max) {
        return [
          'case',
          ['==', ['typeof', ['get', '__pred3PE']], 'number'],
          '#4CAF50',
          '#9e9e9e'
        ];
      }
      // Color gradient from green (low) to red (high)
      return [
        'case',
        ['==', ['typeof', ['get', '__pred3PE']], 'number'],
        [
          'interpolate',
          ['linear'],
          ['get', '__pred3PE'],
          pred3PEStats.min, '#4CAF50',  // Green for low values
          pred3PEStats.min + (pred3PEStats.max - pred3PEStats.min) * 0.25, '#8BC34A',  // Lime green
          pred3PEStats.min + (pred3PEStats.max - pred3PEStats.min) * 0.5, '#FFC107',  // Amber
          pred3PEStats.min + (pred3PEStats.max - pred3PEStats.min) * 0.75, '#FF6F00',  // Red-orange
          pred3PEStats.max, '#B71C1C'  // Dark red for high values
        ],
        '#9e9e9e'
      ];
    };

    const pred3PEColorExpression = buildPred3PEColorExpression();
    const isVisible = censusVisibleRef.current;
    const riskVisibility = view === 'risk' && isVisible ? 'visible' : 'none';
    const pred3PEVisibility = view === 'pred3pe' && isVisible ? 'visible' : 'none';
    const outlineVisibility = isVisible ? 'visible' : 'none';

    if (map.current.getSource('census-tracts')) {
      map.current.getSource('census-tracts').setData(censusDataRef.current);
    } else {
      map.current.addSource('census-tracts', {
        type: 'geojson',
        data: censusDataRef.current
      });
    }

    if (!map.current.getLayer('census-tracts-risk')) {
      map.current.addLayer({
        id: 'census-tracts-risk',
        type: 'fill',
        source: 'census-tracts',
        layout: {
          visibility: riskVisibility
        },
        paint: {
          'fill-color': riskColorExpression,
          'fill-opacity': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            0.7,
            0.5
          ]
        }
      });
    } else {
      map.current.setPaintProperty('census-tracts-risk', 'fill-color', riskColorExpression);
      map.current.setLayoutProperty('census-tracts-risk', 'visibility', riskVisibility);
    }

    // Add PRED3_PE layer
    if (!map.current.getLayer('census-tracts-pred3pe')) {
      map.current.addLayer({
        id: 'census-tracts-pred3pe',
        type: 'fill',
        source: 'census-tracts',
        layout: {
          visibility: pred3PEVisibility
        },
        paint: {
          'fill-color': pred3PEColorExpression,
          'fill-opacity': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            0.7,
            0.5
          ]
        }
      });
    } else {
      map.current.setPaintProperty('census-tracts-pred3pe', 'fill-color', pred3PEColorExpression);
      map.current.setLayoutProperty('census-tracts-pred3pe', 'visibility', pred3PEVisibility);
    }

    // Removed: census-tracts-population layer - population layer disabled
    /* if (!map.current.getLayer('census-tracts-population')) {
      map.current.addLayer({
        id: 'census-tracts-population',
        type: 'fill',
        source: 'census-tracts',
        layout: {
          visibility: populationVisibility
        },
        paint: {
          'fill-color': populationColorExpression,
          'fill-opacity': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            0.8,
            0.6
          ]
        }
      });
    } else {
      map.current.setPaintProperty('census-tracts-population', 'fill-color', populationColorExpression);
      map.current.setLayoutProperty('census-tracts-population', 'visibility', populationVisibility);
    } */

    if (!map.current.getLayer('census-tracts-outline')) {
      map.current.addLayer({
        id: 'census-tracts-outline',
        type: 'line',
        source: 'census-tracts',
        layout: {
          visibility: outlineVisibility
        },
        paint: {
          'line-color': '#777777',
          'line-width': 1,
          'line-opacity': 0.6
        }
      });
    } else {
      map.current.setLayoutProperty('census-tracts-outline', 'visibility', outlineVisibility);
    }

    // Add marker buffer layer above census layers if it exists
    if (map.current.getSource('marker-buffers') && !map.current.getLayer('marker-buffers')) {
      map.current.addLayer({
        id: 'marker-buffers',
        type: 'fill',
        source: 'marker-buffers',
        paint: {
          'fill-color': 'transparent',
          'fill-opacity': 0
        }
      });

      // Add event handlers to buffer layer to prevent census hover
      map.current.on('mouseenter', 'marker-buffers', () => {
        isHoveringMarkerRef.current = true;
        if (hoveredCensusIdRef.current !== null && map.current) {
          map.current.setFeatureState(
            { source: 'census-tracts', id: hoveredCensusIdRef.current },
            { hover: false }
          );
          hoveredCensusIdRef.current = null;
        }
      });

      map.current.on('mouseleave', 'marker-buffers', () => {
        isHoveringMarkerRef.current = false;
      });

      map.current.on('mousemove', 'marker-buffers', () => {
        isHoveringMarkerRef.current = true;
        if (hoveredCensusIdRef.current !== null && map.current) {
          map.current.setFeatureState(
            { source: 'census-tracts', id: hoveredCensusIdRef.current },
            { hover: false }
          );
          hoveredCensusIdRef.current = null;
        }
      });
    }

    if (!censusEventsBoundRef.current) {
      const censusLayerIds = ['census-tracts-risk', 'census-tracts-pred3pe'];

      const handleHover = (e) => {
        if (!map.current) return;
        // Don't activate census hover if we're hovering over a marker
        if (isHoveringMarkerRef.current) return;
        
        const feature = e.features && e.features[0];
        if (!feature || feature.id === undefined || feature.id === null) return;

        if (hoveredCensusIdRef.current !== null) {
          map.current.setFeatureState(
            { source: 'census-tracts', id: hoveredCensusIdRef.current },
            { hover: false }
          );
        }

        hoveredCensusIdRef.current = feature.id;
        map.current.setFeatureState(
          { source: 'census-tracts', id: hoveredCensusIdRef.current },
          { hover: true }
        );
      };

      const handleLeave = () => {
        if (!map.current) return;
        if (hoveredCensusIdRef.current !== null) {
          map.current.setFeatureState(
            { source: 'census-tracts', id: hoveredCensusIdRef.current },
            { hover: false }
          );
        }
        hoveredCensusIdRef.current = null;
        map.current.getCanvas().style.cursor = '';
      };

      const handleClick = (e) => {
        if (!map.current) return;
        const feature = e.features && e.features[0];
        if (!feature) return;
        const props = feature.properties || {};
        const tractName = props['L0Census_Tracts.NAME'] || 'Census Tract';
        const tractId = props['L0Census_Tracts.GEOID'] || feature.id || 'N/A';
        const riskRating = props['__riskRating'] || props['T_FEMA_National_Risk_Index_$_.FEMAIndexRating'] || 'Not Rated';
        const pred3PE = props['__pred3PE'];
        // Removed: riskIndexRaw - only showing rating now

        const popupHtml = `
          <div style="font-family: 'Inter', 'Segoe UI', sans-serif; min-width: 220px;">
            <div style="font-size: 1.05em; font-weight: 700; color: #1b3a4b; margin-bottom: 4px;">${tractName}</div>
            <div style="font-size: 0.85em; color: #546e7a; margin-bottom: 10px;">Tract ID: ${tractId}</div>
            <hr style="border: none; border-top: 1px solid #e0e6ed; margin: 8px 0;" />
            <div style="font-size: 0.9em; color: #1b3a4b; margin-bottom: 4px;">
              <span style="font-weight: 600;">FEMA Risk Rating:</span>
              <span style="margin-left: 6px;">${riskRating}</span>
            </div>
            ${pred3PE !== null && pred3PE !== undefined ? `
            <div style="font-size: 0.9em; color: #1b3a4b; margin-bottom: 12px;">
              <span style="font-weight: 600;">PRED3_PE:</span>
              <span style="margin-left: 6px;">${pred3PE.toFixed(2)}%</span>
            </div>
            ` : ''}
          </div>
        `;

        new mapboxgl.Popup({ closeButton: true, closeOnClick: true })
          .setLngLat(e.lngLat)
          .setHTML(popupHtml)
          .addTo(map.current);
      };

      censusLayerIds.forEach((layerId) => {
        map.current.on('click', layerId, handleClick);
        map.current.on('mouseenter', layerId, () => {
          if (map.current) {
            map.current.getCanvas().style.cursor = 'pointer';
          }
        });
        map.current.on('mousemove', layerId, handleHover);
        map.current.on('mouseleave', layerId, handleLeave);
      });

      censusEventsBoundRef.current = true;
    }

    setCensusLayersReady(true);
  }, []);

  // Toggle between satellite and standard map
  const toggleMapStyle = () => {
    if (!map.current) return;
    
    const newStyle = isSatelliteView ? 'mapbox://styles/mapbox/light-v11' : 'mapbox://styles/mapbox/satellite-v9';
    
    map.current.once('styledata', () => {
      // Commented out: Re-add district polygons after style change (miami_cities.geojson)
      /* Object.keys(districtsRef.current).forEach(districtId => {
        const district = districtsRef.current[districtId];
        
        if (!map.current.getSource(districtId)) {
          map.current.addSource(districtId, {
            type: 'geojson',
            data: {
              type: 'Feature',
              geometry: {
                type: 'Polygon',
                coordinates: [district.coordinates]
              }
            }
          });
        }

        if (!map.current.getLayer(`${districtId}-fill`)) {
          map.current.addLayer({
            id: `${districtId}-fill`,
            type: 'fill',
            source: districtId,
            paint: {
              'fill-color': '#3498db',
              'fill-opacity': 0.1
            }
          });
        }

        if (!map.current.getLayer(`${districtId}-outline`)) {
          map.current.addLayer({
            id: `${districtId}-outline`,
            type: 'line',
            source: districtId,
            paint: {
              'line-color': '#2980b9',
              'line-width': 2,
              'line-opacity': 0.5
            }
          });
        }

        // Re-add event listeners
        map.current.on('click', `${districtId}-fill`, () => {
          zoomToDistrict(districtId);
        });

        map.current.on('mouseenter', `${districtId}-fill`, () => {
          map.current.getCanvas().style.cursor = 'pointer';
        });

        map.current.on('mouseleave', `${districtId}-fill`, () => {
          map.current.getCanvas().style.cursor = '';
        });
      }); */

      // Re-add project markers
      if (allProjectsData) {
        allMarkers.forEach(marker => {
          marker.addTo(map.current);
        });
      }

      addCensusSourceAndLayers();
    });
    
    map.current.setStyle(newStyle);
    setIsSatelliteView(!isSatelliteView);
  };

  useEffect(() => {
    if (map.current) return;

    mapboxgl.accessToken = 'pk.eyJ1IjoiaXNhYWNlZGoiLCJhIjoiY21naTVhc3ZkMDVtbjJzcHBwdnFuOW44MSJ9.3B7ShXPP1-_51v1sFoVMKA';
    
    const loadDistricts = async () => {
    try {
      const response = await fetch('/miami_cities.geojson');
      const geojson = await response.json();

      const districts = {};

      geojson.features.forEach((feature) => {
        const coordinates = feature.geometry.coordinates[0];
        const lngs = coordinates.map(c => c[0]);
        const lats = coordinates.map(c => c[1]);
        const name = feature.properties['NAME'];
        const center = {
          lng: lngs.reduce((a, b) => a + b) / lngs.length,
          lat: lats.reduce((a, b) => a + b) / lats.length
        };
        const districtId = feature.properties['OBJECTID'];
        const cn = Math.pow(-(Math.min(...lngs) - Math.max(...lngs)), 0.12);
        const cs = Math.pow(-(Math.min(...lats) - Math.max(...lats)), 0.12);
        let cf = 0;
        if(cn > cs) {
          cf = cn;
        } else {
          cf = cs
        }
        const zoom = 9 / cf;
        console.log(name + ": " + zoom + " " + cn);
        districts[districtId] = {
          name,
          coordinates,
          zoom,
          center
        }
       {}});
      districtsRef.current = districts;
    }catch(err) {
      console.error('Error loading cities:', err);
    }
    }

    const init = async () => {
      await loadDistricts();
    };

    init();

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/light-v11',
      center: [-80.6327, 25.5516],
      zoom: 11
    });

    map.current.addControl(new mapboxgl.NavigationControl());
    map.current.addControl(new mapboxgl.FullscreenControl());
    map.current.addControl(new mapboxgl.ScaleControl({
      maxWidth: 100,
      unit: 'imperial'
    }));

    map.current.on('load', async () => {
      try {
        // Commented out: miami_cities.geojson layer rendering
        /* Object.keys(districtsRef.current).forEach(districtId => {
          const district = districtsRef.current[districtId];

          map.current.addSource(districtId, {
            type: 'geojson',
            data: {
              type: 'Feature',
              geometry: {
                type: 'Polygon',
                coordinates: [district.coordinates]
              }
            }
          });

          map.current.addLayer({
            id: `${districtId}-fill`,
            type: 'fill',
            source: districtId,
            paint: {
              'fill-color': '#3498db',
              'fill-opacity': 0.1
            }
          });

          map.current.addLayer({
            id: `${districtId}-outline`,
            type: 'line',
            source: districtId,
            paint: {
              'line-color': '#2980b9',
              'line-width': 2,
              'line-opacity': 0.5
            }
          });

          map.current.on('click', `${districtId}-fill`, () => {
            zoomToDistrict(districtId);
          });

          map.current.on('mouseenter', `${districtId}-fill`, () => {
            map.current.getCanvas().style.cursor = 'pointer';
          });

          map.current.on('mouseleave', `${districtId}-fill`, () => {
            map.current.getCanvas().style.cursor = '';
          });
        }); */
      } catch (err) {
        console.error('Map initialization error:', err);
        setError('Error initializing map');
        setLoading(false);
      }

      try {
        const response = await fetch('/Updated_Data_Resilience_Projects_11.25.geojson');

        if (!response.ok) {
          throw new Error(`Failed to load project data: ${response.status}`);
        }

        const data = await response.json();
        setAllProjectsData(data);

        map.current.addSource('projects', {
          type: 'geojson',
          data: data
        });

        // Create invisible buffer zones around each marker
        const bufferFeatures = data.features.map((feature, index) => {
          const coordinates = feature.geometry.coordinates;
          const circleCoords = createCircleBuffer(coordinates, 30); // 30 meter radius buffer
          return {
            type: 'Feature',
            id: `marker-buffer-${index}`,
            geometry: {
              type: 'Polygon',
              coordinates: [circleCoords]
            },
            properties: {
              markerIndex: index
            }
          };
        });

        const bufferGeoJSON = {
          type: 'FeatureCollection',
          features: bufferFeatures
        };

        // Add buffer zones as an invisible layer to intercept mouse events
        map.current.addSource('marker-buffers', {
          type: 'geojson',
          data: bufferGeoJSON
        });

        // Buffer layer will be added in addCensusSourceAndLayers after census layers

        const markers = [];
        data.features.forEach(feature => {
          const coordinates = feature.geometry.coordinates;
          const properties = feature.properties;

          const marker = new mapboxgl.Marker({
            color: getMarkerColor(properties['Type']),
            scale: 1.0
          })
            .setLngLat(coordinates);

          marker.getElement().addEventListener('click', (e) => {
            e.stopPropagation();
            setActiveFeature(feature);
          });

          marker.getElement().addEventListener('mouseenter', (e) => {
            e.stopPropagation();
            // Set flag to prevent census hover
            isHoveringMarkerRef.current = true;
            // Clear any active census hover state
            if (hoveredCensusIdRef.current !== null && map.current) {
              map.current.setFeatureState(
                { source: 'census-tracts', id: hoveredCensusIdRef.current },
                { hover: false }
              );
              hoveredCensusIdRef.current = null;
            }
          });

          marker.getElement().addEventListener('mouseleave', (e) => {
            e.stopPropagation();
            // Clear flag to allow census hover again
            isHoveringMarkerRef.current = false;
          });

          marker.addTo(map.current);
          marker.feature = feature;
          markers.push(marker);
        });

        setAllMarkers(markers);

        const bounds = new mapboxgl.LngLatBounds();
        data.features.forEach(feature => {
          bounds.extend(feature.geometry.coordinates);
        });
        if (!bounds.isEmpty()) {
          map.current.fitBounds(bounds, { padding: 50 });
        }

        setLoading(false);
      } catch (err) {
        console.error('Error loading project data:', err);
        setError('Unable to load project data. Please ensure the GeoJSON file is available or use a CORS proxy.');
        setLoading(false);
      }

      // Load FL_CRE.csv data
      try {
        const csvResponse = await fetch('/FL_CRE.csv');
        if (csvResponse.ok) {
          const csvText = await csvResponse.text();
          const lines = csvText.split('\n').filter(line => line.trim());
          
          // Simple CSV parser that handles quoted fields
          const parseCSVLine = (line) => {
            const result = [];
            let current = '';
            let inQuotes = false;
            for (let i = 0; i < line.length; i++) {
              const char = line[i];
              if (char === '"') {
                inQuotes = !inQuotes;
              } else if (char === ',' && !inQuotes) {
                result.push(current.trim());
                current = '';
              } else {
                current += char;
              }
            }
            result.push(current.trim());
            return result;
          };
          
          const headers = parseCSVLine(lines[0]);
          const geoIdIndex = headers.indexOf('GEO_ID');
          const pred3PEIndex = headers.indexOf('PRED3_PE');
          
          const pred3PEMap = {};
          for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            const values = parseCSVLine(lines[i]);
            if (values.length > Math.max(geoIdIndex, pred3PEIndex)) {
              const geoId = values[geoIdIndex]?.trim();
              const pred3PE = parseFloat(values[pred3PEIndex]?.trim());
              
              if (geoId && !isNaN(pred3PE)) {
                // Convert "1400000US12086000107" to "12086000107"
                const geoid = geoId.replace('1400000US', '');
                pred3PEMap[geoid] = pred3PE;
              }
            }
          }
          pred3PEDataRef.current = pred3PEMap;
          console.log(`[PRED3_PE] Loaded ${Object.keys(pred3PEMap).length} census tract values`);
        }
      } catch (csvError) {
        console.warn('Error loading FL_CRE.csv:', csvError);
      }

      try {
        const response = await fetch('/femaindex.geojson');
        if (!response.ok) {
          throw new Error(`Failed to load census tract data: ${response.status}`);
        }

        const rawGeojson = await response.json();
        const reprojected = reprojectFeatureCollectionIfNeeded(rawGeojson);
        const processedFeatures = (reprojected.features || []).map((feature, index) => {
          const properties = { ...(feature.properties || {}) };
          const riskRating = properties['T_FEMA_National_Risk_Index_$_.FEMAIndexRating'] || null;
          const populationValue = parseNumericValue(
            properties['T_CENSUS_Community_Resilience_Est$_.Total_population__excludes_adult_correctional_juvenile_facilitie']
          );
          const geoid = properties['L0Census_Tracts.GEOID'];
          const pred3PE = geoid ? pred3PEDataRef.current[geoid] : null;

          return {
            ...feature,
            id: feature.id ?? geoid ?? index,
            properties: {
              ...properties,
              __riskRating: riskRating,
              __population: populationValue,
              __pred3PE: pred3PE !== null && pred3PE !== undefined ? pred3PE : null
            }
          };
        });

        const processedGeojson = {
          ...reprojected,
          features: processedFeatures
        };

        const riskRatings = processedFeatures
          .map(feature => feature.properties.__riskRating)
          .filter(value => value !== null && value !== undefined);
        const populationValues = processedFeatures
          .map(feature => feature.properties.__population)
          .filter(value => Number.isFinite(value));
        const pred3PEValues = processedFeatures
          .map(feature => feature.properties.__pred3PE)
          .filter(value => value !== null && value !== undefined && Number.isFinite(value));

        // Get unique risk ratings for stats
        const uniqueRatings = [...new Set(riskRatings)];
        const riskStats = { ratings: uniqueRatings, count: riskRatings.length };
        const populationStats = getRangeStats(populationValues);
        const pred3PEStats = getRangeStats(pred3PEValues);

        const riskMissing = processedFeatures.length - riskRatings.length;
        const populationMissing = processedFeatures.length - populationValues.length;
        const pred3PEMissing = processedFeatures.length - pred3PEValues.length;

        censusDataRef.current = processedGeojson;
        const statsPayload = {
          risk: riskStats,
          population: populationStats,
          pred3PE: pred3PEStats,
          counts: {
            total: processedFeatures.length,
            missingRisk: riskMissing,
            missingPopulation: populationMissing,
            missingPred3PE: pred3PEMissing
          }
        };
        censusStatsRef.current = statsPayload;
        setCensusStats(statsPayload);
        addCensusSourceAndLayers();

        const bounds = new mapboxgl.LngLatBounds();
        let hasBounds = false;
        processedFeatures.forEach(feature => {
          if (!feature.geometry) return;
          walkCoordinates(feature.geometry, coord => {
            if (!hasBounds) {
              bounds.set(coord, coord);
              hasBounds = true;
            } else {
              bounds.extend(coord);
            }
          });
        });

        if (hasBounds) {
          map.current.fitBounds(bounds, { padding: 50, duration: 1200 });
        }

        console.groupCollapsed('[Census] Census Tract Data Summary');
        console.log('Total tracts loaded:', processedFeatures.length);
        console.log('FEMA Risk Ratings found:', uniqueRatings);
        console.log('Population range:', populationStats.min, populationStats.max);
        if (riskMissing > 0) {
          console.warn(`Missing FEMA Risk Rating for ${riskMissing} tracts`, processedFeatures
            .filter(feature => !feature.properties.__riskRating)
            .slice(0, 10)
            .map(feature => feature.properties['L0Census_Tracts.GEOID'] || feature.id));
        }
        if (populationMissing > 0) {
          console.warn(`Missing population for ${populationMissing} tracts`, processedFeatures
            .filter(feature => !Number.isFinite(feature.properties.__population))
            .slice(0, 10)
            .map(feature => feature.properties['L0Census_Tracts.GEOID'] || feature.id));
        }
        console.groupEnd();
        console.info('[Census] Census tract layers added successfully');
      } catch (censusError) {
        console.error('Error loading census tract data:', censusError);
      }
    });
  }, [addCensusSourceAndLayers]);

  useEffect(() => {
    censusVisibleRef.current = censusVisible;
  }, [censusVisible]);

  useEffect(() => {
    censusViewRef.current = activeCensusView;
    if (!map.current) return;
    const riskVisibility = censusVisible && activeCensusView === 'risk' ? 'visible' : 'none';
    const pred3PEVisibility = censusVisible && activeCensusView === 'pred3pe' ? 'visible' : 'none';
    if (map.current.getLayer('census-tracts-risk')) {
      map.current.setLayoutProperty('census-tracts-risk', 'visibility', riskVisibility);
    }
    if (map.current.getLayer('census-tracts-pred3pe')) {
      map.current.setLayoutProperty('census-tracts-pred3pe', 'visibility', pred3PEVisibility);
    }
    if (map.current.getLayer('census-tracts-outline')) {
      map.current.setLayoutProperty('census-tracts-outline', 'visibility', censusVisible ? 'visible' : 'none');
    }
    if (!censusVisible) {
      if (hoveredCensusIdRef.current !== null) {
        map.current.setFeatureState(
          { source: 'census-tracts', id: hoveredCensusIdRef.current },
          { hover: false }
        );
        hoveredCensusIdRef.current = null;
      }
      map.current.getCanvas().style.cursor = '';
    }
    if (censusLayersReady) {
      addCensusSourceAndLayers();
    }
  }, [activeCensusView, censusVisible, censusLayersReady, addCensusSourceAndLayers]);

  useEffect(() => {
    if (censusStats) {
      censusStatsRef.current = censusStats;
      if (censusLayersReady) {
        addCensusSourceAndLayers();
      }
    }
  }, [censusStats, censusLayersReady, addCensusSourceAndLayers]);

  // Legend for risk ratings - More distinctive colors
  const riskRatingColors = {
    'Very Low': '#4CAF50',           // Bright Green
    'Relatively Low': '#8BC34A',     // Lime Green
    'Relatively Moderate': '#FFC107', // Amber/Yellow
    'Relatively High': '#FF6F00',    // Red-Orange
    'Very High': '#B71C1C'           // Dark Red
  };
  
  const legendRatings = censusStats?.risk?.ratings || [];
  const sortedRatings = ['Very Low', 'Relatively Low', 'Relatively Moderate', 'Relatively High', 'Very High']
    .filter(rating => legendRatings.includes(rating));

  return (
    <div style={{ margin: 0, padding: 0, fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif", backgroundColor: 'white', height: '100vh', overflow: 'hidden' }}>
      <div style={{ 
        background: "#01321e", 
        color: 'white', 
        padding: '10px 30px', 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center',
        boxShadow: '0 2px 10px rgba(0,0,0,0.1)' 
      }}>
        <div>
          <h1 style={{ 
            fontSize: '2em', 
            margin: '0', 
            fontWeight: 300,
            fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
            letterSpacing: '0.5px'
          }}>SCALE-R Dashboard</h1>
          <p style={{ 
            fontSize: '0.9em', 
            margin: '3px 0 0 0', 
            opacity: 0.8,
            fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
            fontWeight: 300
          }}>Miami-Dade Climate Resilience Projects</p>
        </div>
        <div style={{ 
          display: 'flex', 
          alignItems: 'center',
          gap: '30px'
        }}>
          <img 
            src="/Images/1019px-NSF_logo.png" 
            alt="NSF Logo" 
            style={{ 
              height: '75px', 
              width: 'auto'
            }} 
          />
          <img 
            src="/Images/Miami_Hurricanes_logo.svg.png" 
            alt="Miami Hurricanes Logo" 
            style={{ 
              height: '50px', 
              width: 'auto'
            }} 
          />
        </div>
      </div>  

      

      <div style={{ display: 'flex', height: 'calc(100vh - 80px)', minHeight: 'calc(100vh - 80px)' }}>
<aside style={{
          width: '30%',
          minWidth: '300px',
          maxWidth: '400px',
          background: '#ffffff',
          borderRight: '1px solid #e0e0e0',
          overflowY: 'auto',
          padding: '20px',
          boxShadow: '2px 0 8px rgba(0,0,0,0.1)'
        }}>
          <h2 style={{ 
            fontSize: '1.5em', 
            fontWeight: '600', 
            color: '#1b3a4b', 
            marginBottom: '20px' 
          }}>
            Filler
          </h2>
          
          <div style={{ marginBottom: '24px' }}>
            <h3 style={{ fontSize: '1.1em', fontWeight: '500', color: '#2c3e50', marginBottom: '12px' }}>
              Filler
            </h3>
            <p style={{ color: '#546e7a', fontSize: '0.95em', lineHeight: '1.6' }}>
              Add content
            </p>
          </div>

          <div style={{ marginBottom: '24px' }}>
            <h3 style={{ fontSize: '1.1em', fontWeight: '500', color: '#2c3e50', marginBottom: '12px' }}>
              Filler
            </h3>
            <p style={{ color: '#546e7a', fontSize: '0.95em', lineHeight: '1.6' }}>
              Add content
            </p>
          </div>
        </aside>

        
        


        <div style={{ flex: 1, position: 'relative', height: '100%' }}>
          <div ref={mapContainer} style={{ width: '100%', height: '100%', minHeight: 'calc(100vh - 80px)' }} />
          {map.current && (
            <MapboxPopup map={map.current} activeFeature={activeFeature} />
          )}

          <div style={{
            position: 'absolute',
            right: '20px',
            bottom: '320px',
            zIndex: 1000
          }}>
            <button
              onClick={handleCensusVisibilityToggle}
              disabled={!censusLayersReady}
              style={{
                padding: '10px 16px',
                background: censusVisible ? 'linear-gradient(135deg, #0b8457, #06623b)' : 'linear-gradient(135deg, #546e7a, #2f4858)',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                cursor: censusLayersReady ? 'pointer' : 'not-allowed',
                fontSize: '0.9em',
                boxShadow: '0 3px 10px rgba(0,0,0,0.2)',
                transition: 'all 0.3s ease'
              }}
            >
              {censusVisible ? 'Hide Census Layer' : 'Show Census Layer'}
            </button>
          </div>

      



          {censusLayersReady && censusStats && censusVisible && (
            <>
              <div style={{
                position: 'absolute',
                bottom: '210px',
                right: '20px',
                zIndex: 1000,
                background: 'rgba(255, 255, 255, 0.95)',
                padding: '16px',
                borderRadius: '8px',
                boxShadow: '0 4px 16px rgba(0, 0, 0, 0.15)',
                minWidth: '220px'
              }}>
                <div style={{ fontSize: '1em', fontWeight: 600, color: '#1b3a4b', marginBottom: '10px' }}>
                  View Layer By:
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', cursor: 'pointer', fontSize: '0.9em', color: '#1b3a4b' }}>
                  <input
                    type="radio"
                    name="census-view"
                    value="risk"
                    checked={activeCensusView === 'risk'}
                    onChange={() => handleCensusViewChange('risk')}
                  />
                  FEMA Risk Index
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.9em', color: '#1b3a4b' }}>
                  <input
                    type="radio"
                    name="census-view"
                    value="pred3pe"
                    checked={activeCensusView === 'pred3pe'}
                    onChange={() => handleCensusViewChange('pred3pe')}
                  />
                  PRED3_PE
                </label>
              </div>

              {activeCensusView === 'risk' && sortedRatings.length > 0 && (
                <div style={{
                  position: 'absolute',
                  right: '20px',
                  bottom: '70px',
                  zIndex: 1000,
                  background: 'rgba(255, 255, 255, 0.95)',
                  padding: '16px',
                  borderRadius: '8px',
                  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.15)',
                  minWidth: '220px'
                }}>
                  <div style={{ fontSize: '1em', fontWeight: 600, color: '#1b3a4b', marginBottom: '12px' }}>
                    FEMA Risk Rating
                  </div>
                  <div style={{ marginBottom: '8px' }}>
                    <div style={{
                      width: '100%',
                      height: '20px',
                      borderRadius: '4px',
                      background: 'linear-gradient(to right, #4CAF50 0%, #8BC34A 25%, #FFC107 50%, #FF6F00 75%, #B71C1C 100%)',
                      border: '1px solid rgba(0,0,0,0.1)',
                      marginBottom: '8px'
                    }}></div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75em', color: '#546e7a' }}>
                      <span>Very Low</span>
                      <span>Very High</span>
                    </div>
                  </div>
                </div>
              )}

              {activeCensusView === 'pred3pe' && censusStats?.pred3PE && (
                <div style={{
                  position: 'absolute',
                  right: '20px',
                  bottom: '70px',
                  zIndex: 1000,
                  background: 'rgba(255, 255, 255, 0.95)',
                  padding: '16px',
                  borderRadius: '8px',
                  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.15)',
                  minWidth: '220px'
                }}>
                  <div style={{ fontSize: '1em', fontWeight: 600, color: '#1b3a4b', marginBottom: '12px' }}>
                    PRED3_PE (%)
                  </div>
                  <div style={{ marginBottom: '8px' }}>
                    <div style={{
                      width: '100%',
                      height: '20px',
                      borderRadius: '4px',
                      background: 'linear-gradient(to right, #4CAF50 0%, #8BC34A 25%, #FFC107 50%, #FF6F00 75%, #B71C1C 100%)',
                      border: '1px solid rgba(0,0,0,0.1)',
                      marginBottom: '8px'
                    }}></div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75em', color: '#546e7a' }}>
                      <span>{censusStats.pred3PE.min?.toFixed(1) || '0'}%</span>
                      <span>{censusStats.pred3PE.max?.toFixed(1) || '0'}%</span>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {loading && (
            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', background: 'rgba(255, 255, 255, 0.9)', padding: '20px', borderRadius: '10px', boxShadow: '0 4px 15px rgba(0,0,0,0.2)', zIndex: 1000 }}>
              <div style={{ width: '40px', height: '40px', border: '4px solid #f3f3f3', borderTop: '4px solid #3498db', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 10px' }}></div>
              <div>{error || 'Loading map and projects...'}</div>
            </div>
          )}


          {/* Map Style Toggle */}
          <div style={{ 
            position: 'absolute', 
            bottom: '30px', 
            right: '20px', 
            background: 'white', 
            borderRadius: '25px', 
            boxShadow: '0 2px 10px rgba(0,0,0,0.2)', 
            zIndex: 1000,
            overflow: 'hidden'
          }}>
            <button
              onClick={toggleMapStyle}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '8px 12px',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontSize: '0.8em',
                color: '#2c3e50',
                transition: 'all 0.3s',
                minWidth: '120px'
              }}
            >
              <div style={{ 
                marginRight: '8px', 
                fontSize: '16px',
                display: 'flex',
                alignItems: 'center'
              }}>
                {isSatelliteView ? '🗺️' : '🛰️'}
              </div>
              <span style={{ fontWeight: '500' }}>
                {isSatelliteView ? 'Standard' : 'Satellite'}
              </span>
            </button>





        </div>
      </div>


      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        .mapboxgl-popup-content {
          border-radius: 10px !important;
          box-shadow: 0 4px 20px rgba(0,0,0,0.2) !important;
          padding-right: 30px; /* space for close button */
        }
        /* Ensure popups render above markers */
        .mapboxgl-popup {
          z-index: 10000 !important;
        }
        .mapboxgl-popup-close-button {
          position: absolute;
          top: 6px;
          right: 6px;
          transform: none; /* ensure it sits inside */
          background: #ffffff;
          border-radius: 4px;
          width: 22px;
          height: 22px;
          line-height: 20px;
          text-align: center;
          border: 1px solid #e1e5ea;
          box-shadow: 0 1px 2px rgba(0,0,0,0.08);
        }
      `}</style>
       </div>
    </div>
  );
};

export default App;

// React-based Mapbox Popup using a portal to render rich content
const MapboxPopup = ({ map, activeFeature }) => {
  const popupRef = useRef(null);
  const contentRef = useRef(typeof document !== 'undefined' ? document.createElement('div') : null);

  // Create popup instance on mount
  useEffect(() => {
    if (!map) return;
    popupRef.current = new mapboxgl.Popup({ closeOnClick: false, offset: 20 });
    return () => {
      if (popupRef.current) popupRef.current.remove();
    };
  }, [map]);

  // Update popup when activeFeature changes
  useEffect(() => {
    if (!map || !popupRef.current) return;
    if (!activeFeature) {
      popupRef.current.remove();
      return;
    }

    const coords = activeFeature.geometry?.coordinates;
    if (!coords) return;

    popupRef.current
      .setLngLat(coords)
      .setHTML(contentRef.current.outerHTML)
      .addTo(map);
  }, [map, activeFeature]);

  if (!contentRef.current) return null;

  const props = activeFeature?.properties || {};

  return (
    <>{createPortal(
      <div className="portal-content" style={{ maxWidth: 360 }}>
        <div style={{ fontSize: '1.05em', fontWeight: 700, color: '#2c3e50', marginBottom: 10 }}>
          {props['Project Name'] || 'Project'}
        </div>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: '0 6px', fontSize: '0.9em' }}>
          <tbody>
            <tr>
              <td style={{ color: '#34495e', fontWeight: 600, width: 110 }}>Type</td>
              <td style={{ color: '#2c3e50' }}>{props['Type'] || '—'}</td>
            </tr>
            <tr>
              <td style={{ color: '#34495e', fontWeight: 600 }}>Category</td>
              <td style={{ color: '#2c3e50' }}>{props['Categories'] || '—'}</td>
            </tr>
            <tr>
              <td style={{ color: '#34495e', fontWeight: 600 }}>Focus</td>
              <td style={{ color: '#2c3e50' }}>{props['Disaster Focus'] || '—'}</td>
            </tr>
            <tr>
              <td style={{ color: '#34495e', fontWeight: 600 }}>City</td>
              <td style={{ color: '#2c3e50' }}>{props['City'] || '—'}</td>
            </tr>
            <tr>
              <td style={{ color: '#34495e', fontWeight: 600 }}>Status</td>
              <td style={{ color: (props['Project Status'] || '').toLowerCase() === 'completed' ? '#27ae60' : '#f39c12', fontWeight: 700 }}>
                {props['Project Status'] || 'Unknown'}
              </td>
            </tr>
            <tr>
              <td style={{ color: '#34495e', fontWeight: 600 }}>Cost</td>
              <td style={{ color: (props['Estimated Project Cost'] == null) ?'#f39c12' : '#27ae60', fontWeight: 700 }}>{
                  (props['Estimated Project Cost'] == null) ? 'Not Disclosed' : "$" + props['Estimated Project Cost']}</td>
            </tr>
          </tbody>
        </table>
        {props['New 15-25 Words Project Description'] && (
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #ecf0f1', color: '#7f8c8d', fontSize: '0.85em', lineHeight: 1.4 }}>
            {props['New 15-25 Words Project Description']}
          </div>
        )}
      </div>,
      contentRef.current
    )}</>
  );
};