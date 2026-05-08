# Bike Route Planner

A professional, high-performance web application for planning and analyzing bike routes.

## Core Features
- **Vector-First Mapping**: Powered by MapLibre GL JS for smooth, GPU-accelerated map rendering.
- **Smart Routing**: Interactive route creation using the OSRM Cycling engine.
- **Elevation Profiling**: High-precision elevation data processed in a background worker.
- **Dynamic Analysis**: Real-time distance and elevation gain/loss calculations.
- **GPX Support**: Import and export your routes in standard GPX format.

## Technology Stack & Data Sources

### Mapping & Routing
- **Map Engine**: [MapLibre GL JS](https://maplibre.org/)
- **Routing Engine**: [OSRM (Open Source Routing Machine)](http://project-osrm.org/)
- **Basemap Styles**: 
  - [CartoDB](https://carto.com/basemaps) (Dark Matter, Voyager, Positron)
  - [OpenStreetMap](https://www.openstreetmap.org/)
  - [OpenTopoMap](https://opentopomap.org/)
  - [CyclOSM](https://www.cyclosm.org/)
  - [ESRI / ArcGIS World Imagery](https://www.esri.com/)

### Data & Logic
- **Elevation Data**: [Mapzen Terrarium](https://github.com/tilezen/joerd/blob/master/docs/terrarium.md) RGB-encoded elevation tiles hosted on AWS S3.
- **Charts**: [Chart.js](https://www.chartjs.org/) for the interactive elevation profile.
- **Worker Threading**: Custom OffscreenCanvas worker for asynchronous elevation sampling without UI jank.

### UI & Assets
- **Typography**: [Inter](https://fonts.google.com/specimen/Inter) via Google Fonts.
- **Icons**: Custom SVG icons inspired by [Lucide](https://lucide.dev/).
- **Styling**: Vanilla CSS with a focus on modern glassmorphism and dark mode aesthetics.

## License
Created by [Ion Cook](https://github.com/ioncook) using [Antigravity](https://antigravity.google).
