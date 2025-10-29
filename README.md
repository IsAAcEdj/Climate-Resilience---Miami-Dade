# Miami-Dade Climate Resilience Projects Dashboard

An interactive React + Vite web app visualizing climate resilience and infrastructure projects in Miami-Dade County using Mapbox GL JS.

## Features

- **Interactive Map** (Mapbox GL JS)
- **Project Tooltip** with a clean two‑column grid layout (name, type, category, focus, city, status, cost, description)
- **Visual encoding**: color by type, size by estimated cost
- **Sidebar** with quick stats and filters
- **District polygons** and view controls

## Getting Started (Development)

Prerequisites:
- Node.js 18+

Install dependencies (first time only):

```bash
npm install
```

Run the dev server:

```bash
npx vite
```

Then open the Local URL printed in the terminal (typically `http://localhost:5173`). Vite supports hot-reload; edits in `src/` update immediately.

Build for production:

```bash
npx vite build
```

Preview the production build:

```bash
npx vite preview
```

## App Structure

- Entry: `index.html`, `src/main.jsx`
- Root component: `src/App.jsx`
- Styles: `src/index.css`
- Static assets and data: `public/`

Key UI areas in `src/App.jsx`:
- Header logos container (UM + NSF): search for `Miami_Hurricanes_logo.svg.png`
- Sidebar container: a `<div>` with `width: '350px'`
- Map container: `<div ref={mapContainer} style={{ width: '100%', height: '100%' }} />`
- Tooltip HTML: `createPopupContent(feature)` function

## Data

- Primary dataset used by the map is served from `public/project_inventory_database.geojson`.
- A sample dataset is available at `public/project_inventory_database_Sample.geojson`.
- District polygons are loaded from `public/miami_cities.geojson`.

## Mapbox Token

The Mapbox access token is set in `src/App.jsx`:

```js
mapboxgl.accessToken = '...';
```

Replace with your own token for deployments.

## Common Tasks

- Adjust logo spacing: edit the header container `gap` style near the logo `<img>` tags.
- Resize logos: change the inline `height` on the respective `<img>` elements.
- Sidebar width: change `width: '350px'` on the sidebar container.
- Tooltip layout: edit `createPopupContent` to adjust the grid labels/values or add fields.

## Troubleshooting

- Changes not appearing:
  - Ensure the Vite server is running (`npx vite`) and you’re on the correct port.
  - Hard refresh (Cmd+Shift+R / Ctrl+F5) or open an incognito window.
- Multiple ports (5173, 5174, …): only one Vite server should be open in the browser.
- HMR not triggering: verify your editor is saving the file and watch for `[vite] hmr update` logs.

## Browser Compatibility

Modern browsers: Chrome, Firefox, Safari, Edge.

## License

Internal project. Licensing TBD.
