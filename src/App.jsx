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

    const riskColors = { min: '#66BB6A', mid: '#FF9800', max: '#C62828', single: '#FF9800' };
    const populationColors = { min: '#fff9c4', mid: '#00ACC1', max: '#0D47A1', single: '#00ACC1' };

    const buildColorExpression = (rangeStats, propertyName, palette) => {
      if (!rangeStats || rangeStats.min === null || rangeStats.max === null) {
        return [
          'case',
          ['==', ['typeof', ['get', propertyName]], 'number'],
          palette.single,
          '#9e9e9e'
        ];
      }
      if (rangeStats.min === rangeStats.max) {
        return [
          'case',
          ['==', ['typeof', ['get', propertyName]], 'number'],
          palette.single,
          '#9e9e9e'
        ];
      }
      return [
        'case',
        ['==', ['typeof', ['get', propertyName]], 'number'],
        [
          'interpolate',
          ['linear'],
          ['get', propertyName],
          rangeStats.min, palette.min,
          rangeStats.mid, palette.mid,
          rangeStats.max, palette.max
        ],
        '#9e9e9e'
      ];
    };

    const riskColorExpression = buildColorExpression(stats.risk, '__riskIndex', riskColors);
    const populationColorExpression = buildColorExpression(stats.population, '__population', populationColors);
    const isVisible = censusVisibleRef.current;
    const riskVisibility = view === 'risk' && isVisible ? 'visible' : 'none';
    const populationVisibility = view === 'population' && isVisible ? 'visible' : 'none';
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

    if (!map.current.getLayer('census-tracts-population')) {
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
    }

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

    if (!censusEventsBoundRef.current) {
      const censusLayerIds = ['census-tracts-risk', 'census-tracts-population'];

      const handleHover = (e) => {
        if (!map.current) return;
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
        const riskRating = props['T_FEMA_National_Risk_Index_$_.FEMAIndexRating'] || 'Not Rated';
        const riskIndexRaw = parseNumericValue(props['T_FEMA_National_Risk_Index_$_.FEMAIndex']);
        const populationRaw = parseNumericValue(
          props['T_CENSUS_Community_Resilience_Est$_.Total_population__excludes_adult_correctional_juvenile_facilitie']
        );

        const popupHtml = `
          <div style="font-family: 'Inter', 'Segoe UI', sans-serif; min-width: 220px;">
            <div style="font-size: 1.05em; font-weight: 700; color: #1b3a4b; margin-bottom: 4px;">${tractName}</div>
            <div style="font-size: 0.85em; color: #546e7a; margin-bottom: 10px;">Tract ID: ${tractId}</div>
            <hr style="border: none; border-top: 1px solid #e0e6ed; margin: 8px 0;" />
            <div style="font-size: 0.9em; color: #1b3a4b; margin-bottom: 4px;">
              <span style="font-weight: 600;">FEMA Risk Rating:</span>
              <span style="margin-left: 6px;">${riskRating}</span>
            </div>
            <div style="font-size: 0.9em; color: #1b3a4b; margin-bottom: 12px;">
              <span style="font-weight: 600;">FEMA Risk Index:</span>
              <span style="margin-left: 6px;">${riskIndexRaw !== null ? riskIndexRaw.toFixed(2) : '—'}</span>
            </div>
            <hr style="border: none; border-top: 1px solid #e0e6ed; margin: 8px 0;" />
            <div style="font-size: 0.9em; color: #1b3a4b;">
              <span style="font-weight: 600;">Population:</span>
              <span style="margin-left: 6px;">${populationRaw !== null ? formatWithCommas(Math.round(populationRaw)) : '—'}</span>
            </div>
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
        const response = await fetch('/project_inventory_database.geojson');

        if (!response.ok) {
          throw new Error(`Failed to load project data: ${response.status}`);
        }

        const data = await response.json();
        setAllProjectsData(data);

        map.current.addSource('projects', {
          type: 'geojson',
          data: data
        });

        const markers = [];
        data.features.forEach(feature => {
          const coordinates = feature.geometry.coordinates;
          const properties = feature.properties;

          const marker = new mapboxgl.Marker({
            color: getMarkerColor(properties['Type']),
            scale: getMarkerSize(properties['Esimated Project Cost']) / 10
          })
            .setLngLat(coordinates);

          marker.getElement().addEventListener('click', () => {
            setActiveFeature(feature);
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

      try {
        const response = await fetch('/femaindex.geojson');
        if (!response.ok) {
          throw new Error(`Failed to load census tract data: ${response.status}`);
        }

        const rawGeojson = await response.json();
        const reprojected = reprojectFeatureCollectionIfNeeded(rawGeojson);
        const processedFeatures = (reprojected.features || []).map((feature, index) => {
          const properties = { ...(feature.properties || {}) };
          const riskValue = parseNumericValue(properties['T_FEMA_National_Risk_Index_$_.FEMAIndex']);
          const populationValue = parseNumericValue(
            properties['T_CENSUS_Community_Resilience_Est$_.Total_population__excludes_adult_correctional_juvenile_facilitie']
          );

          return {
            ...feature,
            id: feature.id ?? properties['L0Census_Tracts.GEOID'] ?? index,
            properties: {
              ...properties,
              __riskIndex: riskValue,
              __population: populationValue
            }
          };
        });

        const processedGeojson = {
          ...reprojected,
          features: processedFeatures
        };

        const riskValues = processedFeatures
          .map(feature => feature.properties.__riskIndex)
          .filter(value => Number.isFinite(value));
        const populationValues = processedFeatures
          .map(feature => feature.properties.__population)
          .filter(value => Number.isFinite(value));

        const riskStats = getRangeStats(riskValues);
        const populationStats = getRangeStats(populationValues);

        const riskMissing = processedFeatures.length - riskValues.length;
        const populationMissing = processedFeatures.length - populationValues.length;

        censusDataRef.current = processedGeojson;
        const statsPayload = {
          risk: riskStats,
          population: populationStats,
          counts: {
            total: processedFeatures.length,
            missingRisk: riskMissing,
            missingPopulation: populationMissing
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
        console.log('FEMA Risk Index range:', riskStats.min, riskStats.max);
        console.log('Population range:', populationStats.min, populationStats.max);
        if (riskMissing > 0) {
          console.warn(`Missing FEMA Risk Index for ${riskMissing} tracts`, processedFeatures
            .filter(feature => !Number.isFinite(feature.properties.__riskIndex))
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
    const populationVisibility = censusVisible && activeCensusView === 'population' ? 'visible' : 'none';
    if (map.current.getLayer('census-tracts-risk')) {
      map.current.setLayoutProperty('census-tracts-risk', 'visibility', riskVisibility);
    }
    if (map.current.getLayer('census-tracts-population')) {
      map.current.setLayoutProperty('census-tracts-population', 'visibility', populationVisibility);
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

  const legendStats = censusStats ? (activeCensusView === 'risk' ? censusStats.risk : censusStats.population) : null;
  const legendColors = activeCensusView === 'risk'
    ? ['#66BB6A', '#FF9800', '#C62828']
    : ['#fff9c4', '#00ACC1', '#0D47A1'];

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
                    value="population"
                    checked={activeCensusView === 'population'}
                    onChange={() => handleCensusViewChange('population')}
                  />
                  Population
                </label>
              </div>

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
                  {activeCensusView === 'risk' ? 'FEMA Risk Index' : 'Population'}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: '8px', gap: '10px' }}>
                  <span style={{ display: 'inline-block', width: '20px', height: '15px', borderRadius: '3px', background: legendColors[0], border: '1px solid rgba(0,0,0,0.1)' }} />
                  <span style={{ fontSize: '0.9em', color: '#1b3a4b' }}>
                    Low: {activeCensusView === 'risk' ? formatRiskValue(legendStats?.min) : formatWithCommas(legendStats?.min != null ? Math.round(legendStats.min) : legendStats?.min)}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: '8px', gap: '10px' }}>
                  <span style={{ display: 'inline-block', width: '20px', height: '15px', borderRadius: '3px', background: legendColors[1], border: '1px solid rgba(0,0,0,0.1)' }} />
                  <span style={{ fontSize: '0.9em', color: '#1b3a4b' }}>
                    Mid: {activeCensusView === 'risk' ? formatRiskValue(legendStats?.mid) : formatWithCommas(legendStats?.mid != null ? Math.round(legendStats.mid) : legendStats?.mid)}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ display: 'inline-block', width: '20px', height: '15px', borderRadius: '3px', background: legendColors[2], border: '1px solid rgba(0,0,0,0.1)' }} />
                  <span style={{ fontSize: '0.9em', color: '#1b3a4b' }}>
                    High: {activeCensusView === 'risk' ? formatRiskValue(legendStats?.max) : formatWithCommas(legendStats?.max != null ? Math.round(legendStats.max) : legendStats?.max)}
                  </span>
                </div>
              </div>
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

<aside style={{
                              width: '30%',
                              minWidth: '300px',
                              maxWidth: '400px',
                              background: '#ffffff',
                              borderLeft: '1px solid #e0e0e0',
                              overflowY: 'auto',
                              padding: '20px',
                              boxShadow: '2px 0 8px rgba(0,0,0,0.1)',
                              flexDirection: 'row-reverse'
                            }}>
                              <h2 style={{
                                fontSize: '1.5em',                               fontWeight: '600', 
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
        {props['Brief Description of the Project'] && (
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #ecf0f1', color: '#7f8c8d', fontSize: '0.85em', lineHeight: 1.4 }}>
            {props['Brief Description of the Project']}
          </div>
        )}
      </div>,
      contentRef.current
    )}</>
  );
};