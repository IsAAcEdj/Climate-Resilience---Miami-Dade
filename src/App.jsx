import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import mapboxgl from 'https://cdn.skypack.dev/mapbox-gl@2.15.0';

const App = () => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const districtsRef = useRef({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [allMarkers, setAllMarkers] = useState([]);
  const [currentDistrict, setCurrentDistrict] = useState(null);
  const [allProjectsData, setAllProjectsData] = useState(null);
  const [isSatelliteView, setIsSatelliteView] = useState(false);
  const [activeFeature, setActiveFeature] = useState(null);

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

  // Toggle between satellite and standard map
  const toggleMapStyle = () => {
    if (!map.current) return;
    
    const newStyle = isSatelliteView ? 'mapbox://styles/mapbox/light-v11' : 'mapbox://styles/mapbox/satellite-v9';
    
    map.current.once('styledata', () => {
      // Re-add district polygons after style change
      Object.keys(districtsRef.current).forEach(districtId => {
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
      });

      // Re-add project markers
      if (allProjectsData) {
        allMarkers.forEach(marker => {
          marker.addTo(map.current);
        });
      }
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
        // Add district polygons
        Object.keys(districtsRef.current).forEach(districtId => {
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
        });

        // Try to load GeoJSON data
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
          map.current.fitBounds(bounds, { padding: 50 });

          setLoading(false);
        } catch (err) {
          console.error('Error loading project data:', err);
          setError('Unable to load project data. Please ensure the GeoJSON file is available or use a CORS proxy.');
          setLoading(false);
        }
      } catch (err) {
        console.error('Map initialization error:', err);
        setError('Error initializing map');
        setLoading(false);
      }
    });
  }, []);

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
            fontSize: '1.8em', 
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
              height: '65px', 
              width: 'auto'
            }} 
          />
          <img 
            src="/Images/Miami_Hurricanes_logo.svg.png" 
            alt="Miami Hurricanes Logo" 
            style={{ 
              height: '45px', 
              width: 'auto'
            }} 
          />
        </div>
      </div>

      <div style={{ display: 'flex', height: 'calc(100vh - 80px)', minHeight: 'calc(100vh - 80px)' }}>
        {/* <div style={{ width: '350px', background: 'white', boxShadow: '2px 0 10px rgba(0,0,0,0.1)', padding: '20px', overflowY: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '30px' }}>
            <div style={{ background: 'linear-gradient(135deg, #3498db, #2980b9)', color: 'white', padding: '15px', borderRadius: '10px', textAlign: 'center' }}>
              <div style={{ fontSize: '1.8em', fontWeight: 'bold', marginBottom: '5px' }}>17</div>
              <div style={{ fontSize: '0.9em', opacity: 0.9 }}>Total Projects</div>
            </div>
            <div style={{ background: 'linear-gradient(135deg, #3498db, #2980b9)', color: 'white', padding: '15px', borderRadius: '10px', textAlign: 'center' }}>
              <div style={{ fontSize: '1.8em', fontWeight: 'bold', marginBottom: '5px' }}>$1B+</div>
              <div style={{ fontSize: '0.9em', opacity: 0.9 }}>Total Investment</div>
            </div>
            <div style={{ background: 'linear-gradient(135deg, #3498db, #2980b9)', color: 'white', padding: '15px', borderRadius: '10px', textAlign: 'center' }}>
              <div style={{ fontSize: '1.8em', fontWeight: 'bold', marginBottom: '5px' }}>2</div>
              <div style={{ fontSize: '0.9em', opacity: 0.9 }}>Completed</div>
            </div>
            <div style={{ background: 'linear-gradient(135deg, #3498db, #2980b9)', color: 'white', padding: '15px', borderRadius: '10px', textAlign: 'center' }}>
              <div style={{ fontSize: '1.8em', fontWeight: 'bold', marginBottom: '5px' }}>15</div>
              <div style={{ fontSize: '0.9em', opacity: 0.9 }}>Ongoing</div>
            </div>
          </div>

          <div style={{ marginBottom: '30px' }}>
            <h3 style={{ color: '#2c3e50', marginBottom: '15px', fontSize: '1.2em' }}>Project Types</h3>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '10px', padding: '8px', background: '#f8f9fa', borderRadius: '5px' }}>
              <div style={{ width: '20px', height: '20px', borderRadius: '50%', marginRight: '10px', border: '2px solid white', boxShadow: '0 2px 4px rgba(0,0,0,0.2)', backgroundColor: '#e74c3c' }}></div>
              <div style={{ fontSize: '0.9em', color: '#2c3e50' }}>Green Infrastructure</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '10px', padding: '8px', background: '#f8f9fa', borderRadius: '5px' }}>
              <div style={{ width: '20px', height: '20px', borderRadius: '50%', marginRight: '10px', border: '2px solid white', boxShadow: '0 2px 4px rgba(0,0,0,0.2)', backgroundColor: '#3498db' }}></div>
              <div style={{ fontSize: '0.9em', color: '#2c3e50' }}>Grey Infrastructure</div>
            </div>
          </div>

          <div style={{ marginBottom: '30px' }}>
            <h3 style={{ color: '#2c3e50', marginBottom: '15px', fontSize: '1.2em' }}>Disaster Focus</h3>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '10px', padding: '8px', background: '#f8f9fa', borderRadius: '5px' }}>
              <div style={{ width: '20px', height: '20px', borderRadius: '50%', marginRight: '10px', border: '2px solid white', boxShadow: '0 2px 4px rgba(0,0,0,0.2)', backgroundColor: '#9b59b6' }}></div>
              <div style={{ fontSize: '0.9em', color: '#2c3e50' }}>Flooding & Sea Level Rise</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '10px', padding: '8px', background: '#f8f9fa', borderRadius: '5px' }}>
              <div style={{ width: '20px', height: '20px', borderRadius: '50%', marginRight: '10px', border: '2px solid white', boxShadow: '0 2px 4px rgba(0,0,0,0.2)', backgroundColor: '#e67e22' }}></div>
              <div style={{ fontSize: '0.9em', color: '#2c3e50' }}>Multi-hazard</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '10px', padding: '8px', background: '#f8f9fa', borderRadius: '5px' }}>
              <div style={{ width: '20px', height: '20px', borderRadius: '50%', marginRight: '10px', border: '2px solid white', boxShadow: '0 2px 4px rgba(0,0,0,0.2)', backgroundColor: '#1abc9c' }}></div>
              <div style={{ fontSize: '0.9em', color: '#2c3e50' }}>Critical Infrastructure</div>
            </div>
          </div>
        </div> */}

        <div style={{ flex: 1, position: 'relative', height: '100%' }}>
          <div ref={mapContainer} style={{ width: '100%', height: '100%', minHeight: 'calc(100vh - 80px)' }} />
          {map.current && (
            <MapboxPopup map={map.current} activeFeature={activeFeature} />
          )}
          
          {loading && (
            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', background: 'rgba(255, 255, 255, 0.9)', padding: '20px', borderRadius: '10px', boxShadow: '0 4px 15px rgba(0,0,0,0.2)', zIndex: 1000 }}>
              <div style={{ width: '40px', height: '40px', border: '4px solid #f3f3f3', borderTop: '4px solid #3498db', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 10px' }}></div>
              <div>{error || 'Loading map and projects...'}</div>
            </div>
          )}

          <div style={{ position: 'absolute', top: '150px', right: '10px', background: 'white', padding: '15px', borderRadius: '10px', boxShadow: '0 2px 10px rgba(0,0,0,0.2)', zIndex: 1000, minWidth: '200px' }}>
            <h4 style={{ margin: '0 0 10px 0', color: '#2c3e50', fontSize: '1em' }}>Special Districts</h4>
            {/* <button
              onClick={() => zoomToDistrict('cutler-bay')}
              style={{
                display: 'block',
                width: '100%',
                padding: '10px',
                marginBottom: '8px',
                background: currentDistrict === 'cutler-bay' ? 'linear-gradient(135deg, #27ae60, #229954)' : 'linear-gradient(135deg, #3498db, #2980b9)',
                color: 'white',
                border: 'none',
                borderRadius: '5px',
                cursor: 'pointer',
                fontSize: '0.9em',
                transition: 'all 0.3s'
              }}
            >
              Cutler Bay
            </button>
            <button
              onClick={() => zoomToDistrict('miami-beach')}
              style={{
                display: 'block',
                width: '100%',
                padding: '10px',
                marginBottom: '8px',
                background: currentDistrict === 'miami-beach' ? 'linear-gradient(135deg, #27ae60, #229954)' : 'linear-gradient(135deg, #3498db, #2980b9)',
                color: 'white',
                border: 'none',
                borderRadius: '5px',
                cursor: 'pointer',
                fontSize: '0.9em',
                transition: 'all 0.3s'
              }}
            >
              Miami Beach
            </button> */}
            <button
              onClick={resetView}
              style={{
                display: 'block',
                width: '100%',
                padding: '10px',
                background: 'linear-gradient(135deg, #95a5a6, #7f8c8d)',
                color: 'white',
                border: 'none',
                borderRadius: '5px',
                cursor: 'pointer',
                fontSize: '0.9em',
                transition: 'all 0.3s'
              }}
            >
              Reset View
            </button>
          </div>

          {/* Map Style Toggle */}
          <div style={{ 
            position: 'absolute', 
            bottom: '20px', 
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
              <td style={{ color: '#27ae60', fontWeight: 700 }}>{props['Estimated Project Cost'] || 'Not disclosed'}</td>
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