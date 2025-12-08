import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import mapboxgl from 'https://cdn.skypack.dev/mapbox-gl@2.15.0';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';


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

// Format cost using compact notation (e.g., "3M", "1.2B")
const formatCostCompact = (cost) => {
  try {
    if (!cost || cost === null || cost === undefined) return null;
    
    // Convert to number if it's a string
    const numericCost = typeof cost === 'string' 
      ? parseFloat(cost.replace(/[$,]/g, '')) 
      : parseFloat(cost);
    
    if (isNaN(numericCost) || !isFinite(numericCost)) return null;
    
    // Format using Intl.NumberFormat with compact notation
    const options = { notation: "compact", compactDisplay: "short" };
    const formattedNumber = new Intl.NumberFormat("en-US", options).format(numericCost);
    
    // Add dollar sign prefix
    return `$${formattedNumber}`;
  } catch (error) {
    console.error('Error formatting cost:', error);
    return null;
  }
};

// Format city name to title case (first letter of each word capitalized)
const formatCityName = (cityName) => {
  if (!cityName || typeof cityName !== 'string') return cityName;
  return cityName
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
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
  const [selectedTypes, setSelectedTypes] = useState([]);
  const [selectedCategories, setSelectedCategories] = useState([]);
  const [selectedDisasterFocus, setSelectedDisasterFocus] = useState([]);
  const [selectedCity, setSelectedCity] = useState('');
  const [cityDropdownOpen, setCityDropdownOpen] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);

  // Listen for popup close events to reset activeFeature state
  useEffect(() => {
    const handlePopupClosed = () => {
      setActiveFeature(null);
    };

    window.addEventListener('popupClosed', handlePopupClosed);

    return () => {
      window.removeEventListener('popupClosed', handlePopupClosed);
    };
  }, []);

  // Close city dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      const cityDropdown = document.querySelector('[data-city-dropdown]');
      if (cityDropdownOpen && cityDropdown && !cityDropdown.contains(event.target)) {
        setCityDropdownOpen(false);
      }
    };

    if (cityDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [cityDropdownOpen]);

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
      case 'Blue Infrastructure':
      case 'Blue':
        return '#3498db';
      case 'Green Infrastructure':
      case 'Green':
        return '#27ae60';
      case 'Grey Infrastructure':
      case 'Grey':
        return '#95a5a6';
      case 'Hybrid':
        return '#9b59b6'; // Purple for hybrid infrastructure
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

    // Use shifted bounds for reset view (shifted northeast)
    if (allMarkers.length > 0) {
      const bounds = new mapboxgl.LngLatBounds();
      allMarkers.forEach(marker => {
        const coords = marker.getLngLat();
        bounds.extend([coords.lng, coords.lat]);
      });
      if (!bounds.isEmpty()) {
        const shiftedBounds = shiftBoundsNortheast(bounds);
        map.current.fitBounds(shiftedBounds, { 
          padding: { top: 100, bottom: 100, left: 100, right: 100 },
          maxZoom: 13,
          duration: 1500 
        });
      }
    } else {
    map.current.flyTo({
      center: [-80.6327, 25.5516],
      zoom: 11,
      duration: 1500
    });
    }
  };




  const addCensusSourceAndLayers = useCallback(() => {
    if (!map.current || !censusDataRef.current) return;

    const stats = censusStatsRef.current;
    const view = censusViewRef.current;

    if (!stats) return;

    // Map risk ratings to numeric values for continuous yellow-to-red scale
    const riskRatingValues = {
      'Very Low': 0,
      'Relatively Low': 0.25,
      'Relatively Moderate': 0.5,
      'Relatively High': 0.75,
      'Very High': 1
    };

    // Build color expression based on risk rating strings using continuous yellow-to-red scale
    const buildRiskRatingColorExpression = () => {
      // First, map rating string to numeric value, then interpolate color
      const ratingCases = [];
      Object.entries(riskRatingValues).forEach(([rating, value]) => {
        ratingCases.push(['==', ['get', '__riskRating'], rating], value);
      });
      // Default to 0.5 (middle) for unknown ratings
      ratingCases.push(0.5);
      
      // Map numeric value to color using continuous yellow-to-red interpolation
      return [
        'interpolate',
        ['linear'],
        ['case', ...ratingCases],
        0, '#FFEB3B',      // Yellow (Very Low)
        0.25, '#FFC107',   // Light Orange-Yellow (Relatively Low)
        0.5, '#FF9800',    // Orange (Relatively Moderate)
        0.75, '#F44336',   // Red (Relatively High)
        1, '#B71C1C'       // Dark Red (Very High)
      ];
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
          '#49006A',
          '#9e9e9e'
        ];
      }
      // Continuous color scale from light purple (low) to dark purple (high)
      // Multiple color stops for better differentiation
      const range = pred3PEStats.max - pred3PEStats.min;
      return [
        'case',
        ['==', ['typeof', ['get', '__pred3PE']], 'number'],
        [
          'interpolate',
          ['linear'],
          ['get', '__pred3PE'],
          pred3PEStats.min, '#E8D4F5',        // Very light purple for minimum values
          pred3PEStats.min + range * 0.1667, '#D4B3E8',  // Light purple
          pred3PEStats.min + range * 0.3333, '#C298DB',  // Medium-light purple
          pred3PEStats.min + range * 0.5, '#A866C7',     // Medium purple
          pred3PEStats.min + range * 0.6667, '#7A3FA8',  // Medium-dark purple (darkened)
          pred3PEStats.min + range * 0.8333, '#5A1D85',  // Dark purple (darkened)
          pred3PEStats.max, '#2D0045'                     // Very dark purple for maximum values (darkened)
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
            0.8,
            0.6
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
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; min-width: 220px;">
            <div style="font-size: 1.05em; font-weight: 700; color: #1b3a4b; margin-bottom: 4px;">${tractName}</div>
            <div style="font-size: 0.85em; color: #546e7a; margin-bottom: 10px;">Tract ID: ${tractId}</div>
            <hr style="border: none; border-top: 1px solid #e0e6ed; margin: 8px 0;" />
            <div style="font-size: 0.9em; color: #1b3a4b; margin-bottom: 4px;">
              <span style="font-weight: 600;">FEMA Risk Rating:</span>
              <span style="margin-left: 6px;">${riskRating}</span>
            </div>
            ${pred3PE !== null && pred3PE !== undefined ? `
            <div style="font-size: 0.9em; color: #1b3a4b; margin-bottom: 12px;">
              <span style="font-weight: 600;">Resilience Index:</span>
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

  // Helper function to shift bounds northeast (to avoid south and west areas)
  const shiftBoundsNortheast = (bounds) => {
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    
    // Calculate ranges
    const lngRange = ne.lng - sw.lng;
    const latRange = ne.lat - sw.lat;
    
    // Shift southwest corner northeast: 55% east, 35% north
    const shiftLng = lngRange * 0.55;
    const shiftLat = latRange * 0.35;
    
    // Create new bounds with shifted southwest corner
    const shiftedBounds = new mapboxgl.LngLatBounds();
    shiftedBounds.extend([sw.lng + shiftLng, sw.lat + shiftLat]);
    shiftedBounds.extend([ne.lng, ne.lat]);
    
    return shiftedBounds;
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
        const response = await fetch('/Cities.geojson');

        if (!response.ok) {
          throw new Error(`Failed to load project data: ${response.status}`);
        }

        const data = await response.json();
        console.log('[Projects] Loaded Cities.geojson:', data.features.length, 'features');
        console.log('[Projects] Sample properties:', data.features[0]?.properties ? Object.keys(data.features[0].properties).slice(0, 10) : 'No properties');
        console.log('[Projects] Sample Infrastruc value:', data.features[0]?.properties?.Infrastruc);
        console.log('[Projects] Sample NAME (city) value:', data.features[0]?.properties?.NAME);
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
          
          // Normalize city property by trimming whitespace (use NAME field, fallback to City)
          const cityField = properties['NAME'] || properties['City'];
          if (cityField) {
            if (properties['NAME']) {
              properties['NAME'] = properties['NAME'].trim();
            }
            if (properties['City']) {
              properties['City'] = properties['City'].trim();
            }
          }

          const marker = new mapboxgl.Marker({
            color: getMarkerColor(properties['Infrastruc'] || properties['Infrastructure Type'] || properties['Type']),
            scale: 0.7
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
          // Use shifted bounds for default position (shifted northeast)
          const shiftedBounds = shiftBoundsNortheast(bounds);
          map.current.fitBounds(shiftedBounds, { 
            padding: { top: 100, bottom: 100, left: 100, right: 100 },
            maxZoom: 13,
            duration: 0 // No animation on initial load
          });
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

  // Legend for risk ratings - now using continuous yellow-to-red scale
  const legendRatings = censusStats?.risk?.ratings || [];
  const sortedRatings = ['Very Low', 'Relatively Low', 'Relatively Moderate', 'Relatively High', 'Very High']
    .filter(rating => legendRatings.includes(rating));

  // Extract unique values for filters
  const getUniqueValues = (field) => {
    if (!allProjectsData?.features) return [];
    const values = allProjectsData.features
      .map(f => {
        // For city, prefer NAME field, fallback to City
        let value;
        if (field === 'City' || field === 'NAME') {
          value = f.properties?.['NAME'] || f.properties?.['City'];
        } else {
          value = f.properties?.[field];
        }
        // Trim whitespace for city fields
        return ((field === 'City' || field === 'NAME') && value) ? value.trim() : value;
      })
      .filter(v => v && v !== null && v !== undefined && v !== 'Null')
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .sort();
    return values;
  };

  // Get unique types - prefer 'Infrastruc', fallback to 'Infrastructure Type' or 'Type'
  const infrastructureTypes = getUniqueValues('Infrastruc');
  const legacyTypes = getUniqueValues('Infrastructure Type');
  const fallbackTypes = getUniqueValues('Type');
  const uniqueTypes = infrastructureTypes.length > 0 ? infrastructureTypes : (legacyTypes.length > 0 ? legacyTypes : fallbackTypes);
  const uniqueCategories = getUniqueValues('Categories');
  const disasterFocusNew = getUniqueValues('Disaster_F');
  const disasterFocusLegacy = getUniqueValues('Disaster Focus');
  const uniqueDisasterFocus = disasterFocusNew.length > 0 ? disasterFocusNew : disasterFocusLegacy;
  // Get unique cities - prefer NAME field, fallback to City
  const uniqueCities = getUniqueValues('NAME');

  // Zoom to city markers when city is selected
  const zoomToCity = (cityName) => {
    if (!map.current || !allMarkers.length) return;

    // If no city selected (All Cities), zoom to all markers (respecting other filters)
    // Filter markers for the selected city, or use all markers if "All Cities"
    const markersToZoom = (!cityName || cityName === '') 
      ? allMarkers.filter(marker => {
          // Include all markers that are currently visible (respecting Type/Disaster Focus filters)
          return marker.getElement().style.display !== 'none';
        })
      : // Filter markers for the selected city
        allMarkers.filter(marker => {
          if (!marker.feature) return false;
          const props = marker.feature.properties || {};
          const markerCity = (props['NAME'] || props['City']) ? (props['NAME'] || props['City']).trim() : (props['NAME'] || props['City']);
          const selectedCityTrimmed = cityName ? cityName.trim() : cityName;
          return markerCity === selectedCityTrimmed;
        });

    if (markersToZoom.length === 0) return;

    // Calculate bounding box from marker positions
    const bounds = new mapboxgl.LngLatBounds();
    markersToZoom.forEach(marker => {
      const coords = marker.getLngLat();
      bounds.extend([coords.lng, coords.lat]);
    });

    if (!bounds.isEmpty()) {
      // If "All Cities" is selected, shift bounds to avoid south and west areas
      if (!cityName || cityName === '') {
        const shiftedBounds = shiftBoundsNortheast(bounds);
        
        map.current.fitBounds(shiftedBounds, { 
          padding: { top: 100, bottom: 100, left: 100, right: 100 },
          maxZoom: 13,
          duration: 1500 
        });
      } else {
        map.current.fitBounds(bounds, { 
          padding: { top: 150, bottom: 150, left: 150, right: 150 },
          maxZoom: 12,
          duration: 1500 
        });
      }
    }
  };

  // Filter markers based on selected filters
  useEffect(() => {
    if (!allMarkers.length || !map.current) return;

    allMarkers.forEach(marker => {
      if (!marker.feature) return;
      const props = marker.feature.properties || {};
      const type = props['Infrastruc'] || props['Infrastructure Type'] || props['Type'];
      const category = props['Categories'];
      const disasterFocus = props['Disaster_F'] || props['Disaster Focus'];
      const city = (props['NAME'] || props['City']) ? (props['NAME'] || props['City']).trim() : (props['NAME'] || props['City']);

      const typeMatch = selectedTypes.length === 0 || selectedTypes.includes(type);
      const disasterMatch = selectedDisasterFocus.length === 0 || selectedDisasterFocus.includes(disasterFocus);
      const selectedCityTrimmed = selectedCity ? selectedCity.trim() : selectedCity;
      const cityMatch = !selectedCityTrimmed || selectedCityTrimmed === '' || city === selectedCityTrimmed;

      const shouldShow = typeMatch && disasterMatch && cityMatch;

      if (shouldShow) {
        marker.getElement().style.display = 'block';
      } else {
        marker.getElement().style.display = 'none';
        // Close popup if the hidden marker's feature is currently active
        if (activeFeature && marker.feature) {
          // Check if it's the same feature (same object reference or same coordinates)
          const isSameFeature = activeFeature === marker.feature ||
            (activeFeature.geometry?.coordinates && marker.feature.geometry?.coordinates &&
             activeFeature.geometry.coordinates[0] === marker.feature.geometry.coordinates[0] &&
             activeFeature.geometry.coordinates[1] === marker.feature.geometry.coordinates[1]);
          
          if (isSameFeature) {
            setActiveFeature(null);
          }
        }
      }
    });
  }, [selectedTypes, selectedDisasterFocus, selectedCity, allMarkers, activeFeature]);

  // Zoom to city when selected (including "All Cities")
  useEffect(() => {
    if (map.current && allMarkers.length && selectedCity !== undefined) {
      // Use setTimeout to ensure markers are filtered/displayed first
      const timeoutId = setTimeout(() => {
        zoomToCity(selectedCity);
      }, 50);
      return () => clearTimeout(timeoutId);
    }
  }, [selectedCity]);

  // Calculate filtered statistics (project count and total investment)
  const filteredStats = useMemo(() => {
    if (!allProjectsData?.features) {
      return { projectCount: 0, totalInvestment: 0 };
    }

    const filteredFeatures = allProjectsData.features.filter(feature => {
      const props = feature.properties || {};
      const type = props['Infrastruc'] || props['Infrastructure Type'] || props['Type'];
      const disasterFocus = props['Disaster_F'] || props['Disaster Focus'];
      const city = (props['NAME'] || props['City']) ? (props['NAME'] || props['City']).trim() : (props['NAME'] || props['City']);
      
      const typeMatch = selectedTypes.length === 0 || selectedTypes.includes(type);
      const disasterMatch = selectedDisasterFocus.length === 0 || selectedDisasterFocus.includes(disasterFocus);
      const selectedCityTrimmed = selectedCity ? selectedCity.trim() : selectedCity;
      const cityMatch = !selectedCityTrimmed || selectedCityTrimmed === '' || city === selectedCityTrimmed;

      return typeMatch && disasterMatch && cityMatch;
    });

    const projectCount = filteredFeatures.length;
    
    // Calculate total investment
    const totalInvestment = filteredFeatures.reduce((sum, feature) => {
      const cost = feature.properties?.['Estimated_'] || feature.properties?.['Estimated Project Cost'];
      if (!cost || cost === null || cost === undefined) return sum;
      
      // Convert to number if it's a string
      const numericCost = typeof cost === 'string' 
        ? parseFloat(cost.replace(/[$,]/g, '')) 
        : parseFloat(cost);
      
      if (isNaN(numericCost) || !isFinite(numericCost)) return sum;
      
      return sum + numericCost;
    }, 0);

    return { projectCount, totalInvestment };
  }, [allProjectsData, selectedTypes, selectedDisasterFocus, selectedCity]);

  // Calculate pie chart data based on city, disaster focus, and infrastructure type filters
  const pieChartData = useMemo(() => {
    if (!allProjectsData?.features) {
      return [];
    }

    // Filter by city, disaster focus, and infrastructure type
    const filteredFeatures = allProjectsData.features.filter(feature => {
      const props = feature.properties || {};
      const type = props['Infrastruc'] || props['Infrastructure Type'] || props['Type'];
      const disasterFocus = props['Disaster_F'] || props['Disaster Focus'];
      const city = (props['NAME'] || props['City']) ? (props['NAME'] || props['City']).trim() : (props['NAME'] || props['City']);
      
      const typeMatch = selectedTypes.length === 0 || selectedTypes.includes(type);
      const disasterMatch = selectedDisasterFocus.length === 0 || selectedDisasterFocus.includes(disasterFocus);
      const selectedCityTrimmed = selectedCity ? selectedCity.trim() : selectedCity;
      const cityMatch = !selectedCityTrimmed || selectedCityTrimmed === '' || city === selectedCityTrimmed;

      return typeMatch && disasterMatch && cityMatch;
    });

    // Count projects by infrastructure type
    const typeCounts = {};
    filteredFeatures.forEach(feature => {
      const props = feature.properties || {};
      const type = props['Infrastruc'] || props['Infrastructure Type'] || props['Type'] || 'Unknown';
      
      // Normalize type names
      let normalizedType = type;
      if (type === 'Blue Infrastructure' || type === 'Blue') {
        normalizedType = 'Blue';
      } else if (type === 'Green Infrastructure' || type === 'Green') {
        normalizedType = 'Green';
      } else if (type === 'Grey Infrastructure' || type === 'Grey') {
        normalizedType = 'Grey';
      } else if (type === 'Hybrid') {
        normalizedType = 'Hybrid';
      }
      
      typeCounts[normalizedType] = (typeCounts[normalizedType] || 0) + 1;
    });

    // Convert to array format for recharts
    const colors = {
      'Blue': '#3498db',
      'Green': '#27ae60',
      'Grey': '#95a5a6',
      'Hybrid': '#9b59b6',
      'Unknown': '#95a5a6'
    };

    return Object.entries(typeCounts)
      .map(([name, value]) => ({
        name,
        value,
        color: colors[name] || '#95a5a6'
      }))
      .sort((a, b) => b.value - a.value); // Sort by count descending
  }, [allProjectsData, selectedTypes, selectedDisasterFocus, selectedCity]);

  return (
    <div style={{ margin: 0, padding: 0, fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif", backgroundColor: 'white', height: '100vh', width: '100%', overflow: 'hidden', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <div style={{ 
        background: "#01321e", 
        color: 'white', 
        padding: '10px 30px', 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center',
        boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
        flexShrink: 0
      }}>
        <div style={{ position: 'relative' }}>
          <h1 
            style={{ 
              fontSize: '2em', 
              margin: '0', 
              fontWeight: 300,
              fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
              letterSpacing: '0.5px',
              cursor: 'pointer',
              transition: 'color 0.2s ease',
              color: showTooltip ? '#60a5fa' : 'white'
            }}
            onMouseEnter={() => setShowTooltip(true)}
            onMouseLeave={() => setShowTooltip(false)}
          >
            SCALE-R Dashboard
          </h1>
          <p style={{ 
            fontSize: '0.9em', 
            margin: '3px 0 0 0', 
            opacity: 0.8,
            fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
            fontWeight: 300
          }}>Miami-Dade Climate Resilience Projects</p>
          
          {/* Rich Info Card Tooltip */}
          <div style={{
            position: 'absolute',
            left: 0,
            top: '100%',
            marginTop: '8px',
            width: '384px',
            backgroundColor: 'rgba(255, 255, 255, 0.8)',
            backdropFilter: 'blur(20px) saturate(180%)',
            WebkitBackdropFilter: 'blur(20px) saturate(180%)',
            borderRadius: '12px',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.15), 0 10px 10px -5px rgba(0, 0, 0, 0.08), inset 0 0 0 1px rgba(255, 255, 255, 0.6)',
            border: '1px solid rgba(255, 255, 255, 0.3)',
            overflow: 'hidden',
            transition: 'all 0.2s ease',
            opacity: showTooltip ? 1 : 0,
            transform: showTooltip ? 'translateY(0)' : 'translateY(-8px)',
            pointerEvents: showTooltip ? 'auto' : 'none',
            zIndex: 1000
          }}>
            <div style={{ padding: '20px' }}>
              <p style={{ 
                fontSize: '0.875rem', 
                color: '#4b5563', 
                lineHeight: '1.75', 
                marginBottom: '16px',
                margin: '0 0 16px 0'
              }}>
                A comprehensive dashboard for visualizing climate resilience projects across Miami-Dade County, featuring interactive maps, project filtering, and community risk assessments.
              </p>
              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: 'repeat(3, 1fr)', 
                gap: '12px', 
                paddingTop: '12px',
                borderTop: '1px solid #f3f4f6'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                    <circle cx="12" cy="10" r="3"></circle>
                  </svg>
                  <div>
                    <p style={{ fontSize: '0.75rem', color: '#9ca3af', margin: '0 0 2px 0' }}>Location</p>
                    <p style={{ fontSize: '0.75rem', fontWeight: 500, color: '#374151', margin: 0 }}>Miami-Dade</p>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                    <circle cx="9" cy="7" r="4"></circle>
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                    <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                  </svg>
                  <div>
                    <p style={{ fontSize: '0.75rem', color: '#9ca3af', margin: '0 0 2px 0' }}>Projects</p>
                    <p style={{ fontSize: '0.75rem', fontWeight: 500, color: '#374151', margin: 0 }}>
                      {allProjectsData?.features?.length || 'Loading...'}
                    </p>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                    <line x1="16" y1="2" x2="16" y2="6"></line>
                    <line x1="8" y1="2" x2="8" y2="6"></line>
                    <line x1="3" y1="10" x2="21" y2="10"></line>
                  </svg>
                  <div>
                    <p style={{ fontSize: '0.75rem', color: '#9ca3af', margin: '0 0 2px 0' }}>Updated</p>
                    <p style={{ fontSize: '0.75rem', fontWeight: 500, color: '#374151', margin: 0 }}>2025</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
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

      

      <div style={{ display: 'flex', flex: 1, width: '100%', overflow: 'hidden', boxSizing: 'border-box', minHeight: 0 }}>
<aside style={{
          width: '24%',
          minWidth: '240px',
          maxWidth: '320px',
          background: 'rgba(255, 255, 255, 0.75)',
          backdropFilter: 'blur(20px) saturate(180%)',
          WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          borderRight: '1px solid rgba(255, 255, 255, 0.3)',
          overflowY: 'auto',
          padding: '20px',
          boxShadow: '2px 0 20px rgba(0, 0, 0, 0.1), inset 0 0 0 1px rgba(255, 255, 255, 0.5)'
        }}>
          {/* City Filter */}
          <div style={{ marginBottom: '24px', position: 'relative' }} data-city-dropdown>
            <h3 style={{ fontSize: '1.1em', fontWeight: '500', color: '#2c3e50', marginBottom: '12px' }}>
              City
            </h3>
            <div
              onClick={() => setCityDropdownOpen(!cityDropdownOpen)}
              style={{
                width: '100%',
                padding: '8px 12px',
                fontSize: '0.9em',
                color: selectedCity ? '#2c3e50' : '#999',
                border: '1px solid rgba(255, 255, 255, 0.4)',
                borderRadius: '8px',
                backgroundColor: 'rgba(255, 255, 255, 0.6)',
                backdropFilter: 'blur(10px) saturate(180%)',
                WebkitBackdropFilter: 'blur(10px) saturate(180%)',
                cursor: 'pointer',
                outline: 'none',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08), inset 0 0 0 1px rgba(255, 255, 255, 0.5)',
                transition: 'all 0.2s ease'
              }}
            >
              <span>{selectedCity ? formatCityName(selectedCity) : 'All Cities'}</span>
              <span style={{ fontSize: '0.7em' }}>▼</span>
            </div>
            {cityDropdownOpen && (
              <div style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                maxHeight: '150px',
                height: '150px',
                overflowY: 'auto',
                backgroundColor: 'rgba(255, 255, 255, 0.85)',
                backdropFilter: 'blur(20px) saturate(180%)',
                WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                border: '1px solid rgba(255, 255, 255, 0.4)',
                borderRadius: '8px',
                marginTop: '4px',
                zIndex: 1000,
                boxShadow: '0 8px 32px rgba(0, 0, 0, 0.12), inset 0 0 0 1px rgba(255, 255, 255, 0.5)'
              }}>
                <div
                  onClick={() => {
                    setSelectedCity('');
                    setCityDropdownOpen(false);
                  }}
                  style={{
                    padding: '8px 12px',
                    cursor: 'pointer',
                    fontSize: '0.9em',
                    color: selectedCity === '' ? '#3498db' : '#2c3e50',
                    backgroundColor: selectedCity === '' ? 'rgba(240, 248, 255, 0.7)' : 'transparent',
                    borderRadius: '6px',
                    transition: 'all 0.2s ease'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(240, 248, 255, 0.5)'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = selectedCity === '' ? 'rgba(240, 248, 255, 0.7)' : 'transparent'}
                >
                  All Cities
                </div>
                {uniqueCities.map(city => (
                  <div
                    key={city}
                    onClick={() => {
                      setSelectedCity(city);
                      setCityDropdownOpen(false);
                    }}
                    style={{
                      padding: '8px 12px',
                      cursor: 'pointer',
                      fontSize: '0.9em',
                      color: selectedCity === city ? '#3498db' : '#2c3e50',
                      backgroundColor: selectedCity === city ? 'rgba(240, 248, 255, 0.7)' : 'transparent',
                      borderRadius: '6px',
                      transition: 'all 0.2s ease'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(240, 248, 255, 0.5)'}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = selectedCity === city ? 'rgba(240, 248, 255, 0.7)' : 'transparent'}
                  >
                    {formatCityName(city)}
                  </div>
                ))}
              </div>
            )}
          </div>
          
          {/* Type Filter */}
          <div style={{ marginBottom: '24px' }}>
            <h3 style={{ fontSize: '1.1em', fontWeight: '500', color: '#2c3e50', marginBottom: '12px' }}>
              Infrastructure Type
            </h3>
            <div style={{ maxHeight: '150px', overflowY: 'auto' }}>
              {uniqueTypes.map(type => (
                <label key={type} style={{ display: 'flex', alignItems: 'center', marginBottom: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={selectedTypes.includes(type)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedTypes([...selectedTypes, type]);
                      } else {
                        setSelectedTypes(selectedTypes.filter(t => t !== type));
                      }
                    }}
                    style={{ marginRight: '8px', cursor: 'pointer' }}
                  />
                  <span style={{ color: '#546e7a', fontSize: '0.9em' }}>{type}</span>
                </label>
              ))}
            </div>
            {selectedTypes.length > 0 && (
              <button
                onClick={() => setSelectedTypes([])}
                style={{
                  marginTop: '8px',
                  padding: '4px 8px',
                  fontSize: '0.85em',
                  background: 'transparent',
                  border: '1px solid #ccc',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  color: '#546e7a'
                }}
              >
                Clear
              </button>
            )}
          </div>

          {/* Disaster Focus Filter */}
          <div style={{ marginBottom: '24px' }}>
            <h3 style={{ fontSize: '1.1em', fontWeight: '500', color: '#2c3e50', marginBottom: '12px' }}>
              Disaster Focus
            </h3>
            <div style={{ maxHeight: '150px', overflowY: 'auto' }}>
              {uniqueDisasterFocus.map(focus => (
                <label key={focus} style={{ display: 'flex', alignItems: 'center', marginBottom: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={selectedDisasterFocus.includes(focus)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedDisasterFocus([...selectedDisasterFocus, focus]);
                      } else {
                        setSelectedDisasterFocus(selectedDisasterFocus.filter(f => f !== focus));
                      }
                    }}
                    style={{ marginRight: '8px', cursor: 'pointer' }}
                  />
                  <span style={{ color: '#546e7a', fontSize: '0.9em' }}>{focus}</span>
                </label>
              ))}
            </div>
            {selectedDisasterFocus.length > 0 && (
              <button
                onClick={() => setSelectedDisasterFocus([])}
                style={{
                  marginTop: '8px',
                  padding: '4px 8px',
                  fontSize: '0.85em',
                  background: 'transparent',
                  border: '1px solid #ccc',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  color: '#546e7a'
                }}
              >
                Clear
              </button>
            )}
          </div>

          {/* Statistics Squares */}
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: '1fr 1fr', 
            gap: '12px', 
            marginTop: '24px',
            paddingTop: '24px',
            borderTop: '1px solid rgba(0, 0, 0, 0.1)'
          }}>
            {/* Total Projects Square */}
            <div style={{
              background: 'rgba(255, 255, 255, 0.8)',
              backdropFilter: 'blur(10px) saturate(180%)',
              WebkitBackdropFilter: 'blur(10px) saturate(180%)',
              border: '1px solid rgba(255, 255, 255, 0.4)',
              borderRadius: '12px',
              padding: '16px',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.08), inset 0 0 0 1px rgba(255, 255, 255, 0.5)',
              textAlign: 'center'
            }}>
              <div style={{ 
                fontSize: '1.75em', 
                fontWeight: 700, 
                color: '#2c3e50',
                marginBottom: '4px'
              }}>
                {filteredStats.projectCount}
              </div>
              <div style={{ 
                fontSize: '0.75em', 
                color: '#546e7a',
                fontWeight: 500
              }}>
                Projects
              </div>
            </div>
            
            {/* Total Investment Square */}
            <div style={{
              background: 'rgba(255, 255, 255, 0.8)',
              backdropFilter: 'blur(10px) saturate(180%)',
              WebkitBackdropFilter: 'blur(10px) saturate(180%)',
              border: '1px solid rgba(255, 255, 255, 0.4)',
              borderRadius: '12px',
              padding: '16px',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.08), inset 0 0 0 1px rgba(255, 255, 255, 0.5)',
              textAlign: 'center'
            }}>
              <div style={{ 
                fontSize: '1.5em', 
                fontWeight: 700, 
                color: '#2c3e50',
                marginBottom: '4px',
                lineHeight: 1.2
              }}>
                {filteredStats.totalInvestment > 0 
                  ? formatCostCompact(filteredStats.totalInvestment)
                  : '—'}
              </div>
              <div style={{ 
                fontSize: '0.75em', 
                color: '#546e7a',
                fontWeight: 500
              }}>
                Total Investment
              </div>
            </div>
          </div>

          {/* Pie Chart */}
          {pieChartData.length > 0 && (
            <div style={{
              marginTop: '24px',
              paddingTop: '24px',
              borderTop: '1px solid rgba(0, 0, 0, 0.1)'
            }}>
              <h3 style={{ 
                fontSize: '1em', 
                fontWeight: '500', 
                color: '#2c3e50', 
                marginBottom: '12px',
                textAlign: 'center'
              }}>
                Infrastructure Type Distribution
              </h3>
              <div style={{
                background: 'rgba(255, 255, 255, 0.8)',
                backdropFilter: 'blur(10px) saturate(180%)',
                WebkitBackdropFilter: 'blur(10px) saturate(180%)',
                border: '1px solid rgba(255, 255, 255, 0.4)',
                borderRadius: '12px',
                padding: '12px',
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.08), inset 0 0 0 1px rgba(255, 255, 255, 0.5)'
              }}>
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie
                      data={pieChartData}
                      cx="50%"
                      cy="50%"
                      outerRadius={55}
                      fill="#8884d8"
                      dataKey="value"
                      isAnimationActive={false}
                    >
                      {pieChartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip 
                      formatter={(value) => [`${value} projects`, 'Count']}
                      contentStyle={{
                        backgroundColor: 'rgba(255, 255, 255, 0.95)',
                        border: '1px solid rgba(0, 0, 0, 0.1)',
                        borderRadius: '8px',
                        padding: '8px'
                      }}
                    />
                    <Legend 
                      verticalAlign="bottom"
                      height={36}
                      iconType="circle"
                      wrapperStyle={{ fontSize: '0.75em', paddingTop: '8px' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </aside>

        
        


        <div style={{ flex: 1, position: 'relative', height: '100%', width: '100%', minWidth: 0, overflow: 'hidden', boxSizing: 'border-box' }}>
          <div ref={mapContainer} style={{ width: '100%', height: '100%', minWidth: 0, overflow: 'hidden', boxSizing: 'border-box' }} />
          {map.current && (
            <MapboxPopup map={map.current} activeFeature={activeFeature} />
          )}

          <div style={{
            position: 'absolute',
            right: '20px',
            bottom: '300px',
            zIndex: 1000
          }}>
            <button
              onClick={handleCensusVisibilityToggle}
              disabled={!censusLayersReady}
              style={{
                padding: '10px 16px',
                background: censusVisible 
                  ? 'linear-gradient(135deg, rgba(11, 132, 87, 0.85), rgba(6, 98, 59, 0.85))' 
                  : 'linear-gradient(135deg, rgba(84, 110, 122, 0.85), rgba(47, 72, 88, 0.85))',
                backdropFilter: 'blur(10px) saturate(180%)',
                WebkitBackdropFilter: 'blur(10px) saturate(180%)',
                color: '#ffffff',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '8px',
                cursor: censusLayersReady ? 'pointer' : 'not-allowed',
                fontSize: '0.9em',
                boxShadow: '0 4px 20px rgba(0, 0, 0, 0.2), inset 0 0 0 1px rgba(255, 255, 255, 0.2)',
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
                bottom: '190px',
                right: '20px',
                zIndex: 1000,
                background: 'rgba(255, 255, 255, 0.75)',
                backdropFilter: 'blur(20px) saturate(180%)',
                WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                padding: '16px',
                borderRadius: '12px',
                boxShadow: '0 8px 32px rgba(0, 0, 0, 0.12), inset 0 0 0 1px rgba(255, 255, 255, 0.6)',
                border: '1px solid rgba(255, 255, 255, 0.3)',
                minWidth: '220px'
              }}>
                <div style={{ fontSize: '1em', fontWeight: 600, color: '#1b3a4b', marginBottom: '10px' }}>
                  Modelling Layer
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', cursor: 'pointer', fontSize: '0.9em', color: '#1b3a4b' }}>
                  <input
                    type="radio"
                    name="census-view"
                    value="risk"
                    checked={activeCensusView === 'risk'}
                    onChange={() => handleCensusViewChange('risk')}
                  />
                  Risk Index
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.9em', color: '#1b3a4b' }}>
                  <input
                    type="radio"
                    name="census-view"
                    value="pred3pe"
                    checked={activeCensusView === 'pred3pe'}
                    onChange={() => handleCensusViewChange('pred3pe')}
                  />
                  Resilience Index
                </label>
              </div>

              {activeCensusView === 'risk' && sortedRatings.length > 0 && (
                <div style={{
                  position: 'absolute',
                  right: '20px',
                  bottom: '70px',
                  zIndex: 1000,
                  background: 'rgba(255, 255, 255, 0.75)',
                  backdropFilter: 'blur(20px) saturate(180%)',
                  WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                  padding: '16px',
                  borderRadius: '12px',
                  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.12), inset 0 0 0 1px rgba(255, 255, 255, 0.6)',
                  border: '1px solid rgba(255, 255, 255, 0.3)',
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
                      overflow: 'hidden',
                      marginBottom: '8px'
                    }}>
                      <div style={{
                        width: '100%',
                        height: '100%',
                        background: 'linear-gradient(to right, #FFEB3B 0%, #FFEB3B 10%, #FFC107 28%, #FF9800 50%, #F44336 72%, #B71C1C 90%, #B71C1C 100%)'
                    }}></div>
                    </div>
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
                  background: 'rgba(255, 255, 255, 0.75)',
                  backdropFilter: 'blur(20px) saturate(180%)',
                  WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                  padding: '16px',
                  borderRadius: '12px',
                  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.12), inset 0 0 0 1px rgba(255, 255, 255, 0.6)',
                  border: '1px solid rgba(255, 255, 255, 0.3)',
                  minWidth: '220px'
                }}>
                  <div style={{ fontSize: '1em', fontWeight: 600, color: '#1b3a4b', marginBottom: '12px' }}>
                    Resilience Index (%)
                  </div>
                  <div style={{ marginBottom: '8px' }}>
                    <div style={{
                      width: '100%',
                      height: '20px',
                      borderRadius: '4px',
                      overflow: 'hidden',
                      marginBottom: '8px'
                    }}>
                      <div style={{
                        width: '100%',
                        height: '100%',
                        background: 'linear-gradient(to right, #E8D4F5 0%, #E8D4F5 10%, #D4B3E8 20%, #C298DB 35%, #A866C7 50%, #7A3FA8 65%, #5A1D85 80%, #2D0045 90%, #2D0045 100%)'
                      }}></div>
                    </div>
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
            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', background: 'rgba(255, 255, 255, 0.8)', backdropFilter: 'blur(20px) saturate(180%)', WebkitBackdropFilter: 'blur(20px) saturate(180%)', padding: '20px', borderRadius: '16px', boxShadow: '0 8px 32px rgba(0, 0, 0, 0.15), inset 0 0 0 1px rgba(255, 255, 255, 0.6)', border: '1px solid rgba(255, 255, 255, 0.3)', zIndex: 1000 }}>
              <div style={{ width: '40px', height: '40px', border: '4px solid #f3f3f3', borderTop: '4px solid #3498db', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 10px' }}></div>
              <div>{error || 'Loading map and projects...'}</div>
            </div>
          )}


          {/* Map Style Toggle */}
          <div style={{ 
            position: 'absolute', 
            bottom: '30px', 
            right: '20px', 
            background: 'rgba(255, 255, 255, 0.75)',
            backdropFilter: 'blur(20px) saturate(180%)',
            WebkitBackdropFilter: 'blur(20px) saturate(180%)',
            borderRadius: '25px', 
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.12), inset 0 0 0 1px rgba(255, 255, 255, 0.6)',
            border: '1px solid rgba(255, 255, 255, 0.3)',
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
          background: rgba(255, 255, 255, 0.85) !important;
          backdrop-filter: blur(20px) saturate(180%) !important;
          -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
          border-radius: 16px !important;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15), inset 0 0 0 1px rgba(255, 255, 255, 0.6) !important;
          border: 1px solid rgba(255, 255, 255, 0.3) !important;
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
          background: rgba(255, 255, 255, 0.8) !important;
          backdrop-filter: blur(10px) saturate(180%) !important;
          -webkit-backdrop-filter: blur(10px) saturate(180%) !important;
          border-radius: 6px;
          width: 22px;
          height: 22px;
          line-height: 20px;
          text-align: center;
          border: 1px solid rgba(255, 255, 255, 0.4);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1), inset 0 0 0 1px rgba(255, 255, 255, 0.5);
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
    
    // Add event listener for popup close event
    const handlePopupClose = () => {
      // Dispatch custom event to notify App component that popup was closed
      window.dispatchEvent(new CustomEvent('popupClosed'));
    };
    
    popupRef.current.on('close', handlePopupClose);
    
    return () => {
      if (popupRef.current) {
        popupRef.current.off('close', handlePopupClose);
        popupRef.current.remove();
      }
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
          {props['Project_Na'] || props['Project Name'] || 'Project'}
        </div>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: '0 6px', fontSize: '0.9em' }}>
          <tbody>
            <tr>
              <td style={{ color: '#34495e', fontWeight: 600, width: 110 }}>Infrastructure Type</td>
              <td style={{ color: '#2c3e50' }}>{props['Infrastruc'] || props['Infrastructure Type'] || props['Type'] || '—'}</td>
            </tr>
            <tr>
              <td style={{ color: '#34495e', fontWeight: 600 }}>Category</td>
              <td style={{ color: '#2c3e50' }}>{props['Categories'] || '—'}</td>
            </tr>
            <tr>
              <td style={{ color: '#34495e', fontWeight: 600 }}>Focus</td>
              <td style={{ color: '#2c3e50' }}>{props['Disaster_F'] || props['Disaster Focus'] || '—'}</td>
            </tr>
            <tr>
              <td style={{ color: '#34495e', fontWeight: 600 }}>City</td>
              <td style={{ color: '#2c3e50' }}>{(props['NAME'] || props['City']) ? formatCityName((props['NAME'] || props['City']).trim()) : '—'}</td>
            </tr>
            <tr>
              <td style={{ color: '#34495e', fontWeight: 600 }}>Status</td>
              <td style={{ color: (props['Project__1'] || props['Project Status'] || '').toLowerCase() === 'completed' ? '#27ae60' : '#f39c12', fontWeight: 700 }}>
                {props['Project__1'] || props['Project Status'] || 'Unknown'}
              </td>
            </tr>
            <tr>
              <td style={{ color: '#34495e', fontWeight: 600 }}>Cost</td>
              <td style={{ color: ((props['Estimated_'] || props['Estimated Project Cost']) == null) ?'#f39c12' : '#27ae60', fontWeight: 700 }}>{
                  formatCostCompact(props['Estimated_'] || props['Estimated Project Cost']) || 'Not Disclosed'}</td>
            </tr>
          </tbody>
        </table>
        {(props['New_15_25_'] || props['New 15-25 Words Project Description']) && (
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #ecf0f1', color: '#7f8c8d', fontSize: '0.85em', lineHeight: 1.4 }}>
            {props['New_15_25_'] || props['New 15-25 Words Project Description']}
          </div>
        )}
      </div>,
      contentRef.current
    )}</>
  );
};