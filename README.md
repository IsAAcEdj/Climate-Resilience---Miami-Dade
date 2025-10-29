# Miami‑Dade Climate Resilience Dashboard

A fast, map‑centric app to explore climate resilience and infrastructure projects across Miami‑Dade.

## What this tool helps you do
- See where projects are and what they focus on (type, category, hazard focus, city)
- Compare investment scale quickly (marker color/size encodes type and cost)
- Drill into any project with a clean, readable popup
- Navigate districts and reset views effortlessly

## Technologies
- React (UI)
- Vite (dev server/build, HMR)
- Mapbox GL JS (interactive map, markers, popups)
- GeoJSON (project and district data)

## Run locally
Prereq: Node.js 18+

```bash
npm install
```

Run the dev server:

```bash
npx vite
```

Open the URL shown (typically `http://localhost:5173`). If 5173 is busy, Vite picks the next port.

Build for production:

```bash
npx vite build
```

Preview the production build:

```bash
npx vite preview
```

## Key code (for quick edits)
- Sidebar width/content: `src/App.jsx` (left panel `width: '350px'`)
- Logos and spacing: header `<img>` elements (container `gap`)
- Popups: `createPopupContent(...)` and React portal `MapboxPopup` in `src/App.jsx`

## Data
- Projects: `public/project_inventory_database.geojson`
- Sample: `public/project_inventory_database_Sample.geojson`
- Districts: `public/miami_cities.geojson`

Mapbox token is set in `src/App.jsx` (`mapboxgl.accessToken = '...'`). Replace for deployments.

## Troubleshooting
- Not seeing changes? Ensure Vite is running, use the printed port, and hard refresh.
- Popup close button position can be adjusted via `.mapboxgl-popup-close-button` styles in `src/App.jsx`.

## Git: Commit and Push

```bash
git add -A
git commit -m "Describe your changes"
git push origin main
```

If HTTPS prompts fail on macOS, set Keychain helper:

```bash
git config --global credential.helper osxkeychain
```

Or switch to SSH:

```bash
git remote set-url origin git@github.com:IsAAcEdj/Climate-Resilience---Miami-Dade.git
git push origin main
```

## Browser Compatibility

Modern browsers: Chrome, Firefox, Safari, Edge.

## License

Internal project. Licensing TBD.
