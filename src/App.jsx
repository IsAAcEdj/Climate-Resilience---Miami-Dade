import React, { useState, useEffect, useRef } from 'react';
import mapboxgl from 'https://cdn.skypack.dev/mapbox-gl@2.15.0';
import features from './project_inventory_database.geojson';

const App = () => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [allMarkers, setAllMarkers] = useState([]);
  const [currentDistrict, setCurrentDistrict] = useState(null);
  const [allProjectsData, setAllProjectsData] = useState(null);

  // Define district boundaries
  const districts = {
    'cutler-bay': {
      name: 'Cutler Bay',
      coordinates: [
        [-80.40, 25.55],
        [-80.30, 25.55],
        [-80.30, 25.60],
        [-80.35, 25.60],
        [-80.40, 25.55]
      ],
      center: [-80.325, 25.575],
      zoom: 13
    },
    'miami-beach': {
      name: 'Miami Beach',
      coordinates: [
        [-80.15, 25.75],
        [-80.13, 25.75],
        [-80.115, 25.84],
        [-80.115, 25.88],
        [-80.12, 25.90],
        [-80.15, 25.89],
        [-80.15, 25.82],
        [-80.17, 25.77],
        [-80.15, 25.75]
      ],
      center: [-80.13, 25.785],
      zoom: 13
    }
  };

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

  // Create popup content
  const createPopupContent = (feature) => {
    const props = feature.properties;
    const cost = props['Esimated Project Cost'] || 'Not disclosed';
    const status = props['Project Status'] || 'Unknown';
    
    return `
      <div style="padding: 15px; min-width: 250px;">
        <div style="font-size: 1.2em; font-weight: bold; color: #2c3e50; margin-bottom: 10px; line-height: 1.3;">
          ${props['Project Name']}
        </div>
        <div style="margin-bottom: 8px; font-size: 0.9em;">
          <span style="font-weight: bold; color: #34495e; display: inline-block; width: 80px;">Type:</span>
          <span style="color: #2c3e50;">${props['Type']}</span>
        </div>
        <div style="margin-bottom: 8px; font-size: 0.9em;">
          <span style="font-weight: bold; color: #34495e; display: inline-block; width: 80px;">Category:</span>
          <span style="color: #2c3e50;">${props['Categories']}</span>
        </div>
        <div style="margin-bottom: 8px; font-size: 0.9em;">
          <span style="font-weight: bold; color: #34495e; display: inline-block; width: 80px;">Focus:</span>
          <span style="color: #2c3e50;">${props['Disaster Focus']}</span>
        </div>
        <div style="margin-bottom: 8px; font-size: 0.9em;">
          <span style="font-weight: bold; color: #34495e; display: inline-block; width: 80px;">City:</span>
          <span style="color: #2c3e50;">${props['City']}</span>
        </div>
        <div style="margin-bottom: 8px; font-size: 0.9em;">
          <span style="font-weight: bold; color: #34495e; display: inline-block; width: 80px;">Status:</span>
          <span style="color: ${status.toLowerCase() === 'completed' ? '#27ae60' : '#f39c12'}; font-weight: bold;">${status}</span>
        </div>
        <div style="margin-bottom: 8px; font-size: 0.9em;">
          <span style="font-weight: bold; color: #34495e; display: inline-block; width: 80px;">Cost:</span>
          <span style="color: #27ae60; font-weight: bold;">${cost}</span>
        </div>
        <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #ecf0f1; font-size: 0.85em; color: #7f8c8d; line-height: 1.4;">
          ${props['Brief Description of the Project']}
        </div>
      </div>
    `;
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
    const district = districts[districtId];
    if (!district || !map.current) return;

    setCurrentDistrict(districtId);

    map.current.flyTo({
      center: district.center,
      zoom: district.zoom,
      duration: 1500
    });

    Object.keys(districts).forEach(id => {
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

    Object.keys(districts).forEach(id => {
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
      center: [-80.2, 25.8],
      zoom: 11,
      duration: 1500
    });
  };

  useEffect(() => {
    if (map.current) return;

    mapboxgl.accessToken = 'pk.eyJ1IjoiaXNhYWNlZGoiLCJhIjoiY21naTVhc3ZkMDVtbjJzcHBwdnFuOW44MSJ9.3B7ShXPP1-_51v1sFoVMKA';
    
    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/light-v11',
      center: [-80.2, 25.8],
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
        Object.keys(districts).forEach(districtId => {
          const district = districts[districtId];
          
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
          const response = await fetch('project_inventory_database.geojson');
          
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
            
            const popup = new mapboxgl.Popup({
              offset: 25,
              closeButton: true,
              closeOnClick: false
            }).setHTML(createPopupContent(feature));

            const marker = new mapboxgl.Marker({
              color: getMarkerColor(properties['Type']),
              scale: getMarkerSize(properties['Esimated Project Cost']) / 10
            })
            .setLngLat(coordinates)
            .setPopup(popup);
            
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
    <div style={{ margin: 0, padding: 0, fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif", backgroundColor: '#f5f5f5' }}>
      <div style={{ background: 'linear-gradient(135deg, #2c3e50 0%, #3498db 100%)', color: 'white', padding: '20px', textAlign: 'center', boxShadow: '0 2px 10px rgba(0,0,0,0.1)' }}>
        <h1 style={{ fontSize: '2.5em', marginBottom: '10px', fontWeight: 300 }}>Miami-Dade Climate Resilience Projects</h1>
        <p style={{ fontSize: '1.2em', opacity: 0.9 }}>Interactive Dashboard for Infrastructure and Adaptation Initiatives</p>
      </div>

      <div style={{ display: 'flex', height: 'calc(100vh - 120px)' }}>
        <div style={{ width: '350px', background: 'white', boxShadow: '2px 0 10px rgba(0,0,0,0.1)', padding: '20px', overflowY: 'auto' }}>
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
        </div>

        <div style={{ flex: 1, position: 'relative' }}>
          <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
          
          {loading && (
            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', background: 'rgba(255, 255, 255, 0.9)', padding: '20px', borderRadius: '10px', boxShadow: '0 4px 15px rgba(0,0,0,0.2)', zIndex: 1000 }}>
              <div style={{ width: '40px', height: '40px', border: '4px solid #f3f3f3', borderTop: '4px solid #3498db', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 10px' }}></div>
              <div>{error || 'Loading map and projects...'}</div>
            </div>
          )}

          <div style={{ position: 'absolute', top: '20px', right: '20px', background: 'white', padding: '15px', borderRadius: '10px', boxShadow: '0 2px 10px rgba(0,0,0,0.2)', zIndex: 1000, minWidth: '200px' }}>
            <h4 style={{ margin: '0 0 10px 0', color: '#2c3e50', fontSize: '1em' }}>Special Districts</h4>
            <button
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
            </button>
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
        }
      `}</style>
    </div>
  );
};

export default App;