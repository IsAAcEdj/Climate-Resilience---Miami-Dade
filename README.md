# Miami-Dade Climate Resilience Projects Dashboard

An interactive web dashboard for visualizing climate resilience and infrastructure projects in Miami-Dade County.

## Features

- **Interactive Map**: Visualize all 17 climate resilience projects on a Mapbox-powered map
- **Project Details**: Click on any marker to see detailed project information including:
  - Project name and type
  - Category and disaster focus
  - City and implementing agency
  - Project status and estimated cost
  - Brief description
- **Visual Indicators**: 
  - Color-coded markers by project type (Green vs Grey Infrastructure)
  - Marker size based on project cost
  - Legend for easy interpretation
- **Statistics Panel**: Overview of total projects, investment, and completion status

## How to Use

1. **Open the Dashboard**: Simply open `dashboard.html` in your web browser
2. **Navigate the Map**: 
   - Zoom in/out using mouse wheel or +/- buttons
   - Pan by clicking and dragging
   - Use fullscreen mode for better viewing
3. **View Project Details**: Click on any project marker to see a popup with detailed information
4. **Understand the Legend**: 
   - Red markers: Green Infrastructure projects
   - Blue markers: Grey Infrastructure projects
   - Larger markers: Higher cost projects

## Project Data

The dashboard displays 17 climate resilience projects including:

- **Miami Beach Projects** (6): Including Maurice Gibb Memorial Park and Miami Beach Convention Center
- **Cutler Bay Projects** (11): Primarily drainage improvements across various neighborhoods

**Total Investment**: Over $1 billion across all projects
**Focus Areas**: Primarily flooding and sea level rise mitigation
**Project Types**: Mix of green infrastructure and traditional grey infrastructure solutions

## Technical Details

- Built with HTML5, CSS3, and JavaScript
- Uses Mapbox GL JS for interactive mapping
- Loads GeoJSON data from `project_inventory_database.geojson`
- Responsive design that works on desktop and mobile devices

## Browser Compatibility

Works best on modern browsers including:
- Chrome (recommended)
- Firefox
- Safari
- Edge

## Data Source

Project data is sourced from the `project_inventory_database.geojson` file, which contains detailed information about each climate resilience project including location coordinates, project details, costs, and timelines.
