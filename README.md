# Bike Route Planner

A professional, high-performance web application for planning, customizing, and analyzing bike routes.

## Core Features

- **Vector-First Mapping**: Powered by MapLibre GL JS for smooth, GPU-accelerated 2D and 3D map rendering.
- **Smart Routing & Editing**:
  - Interactive route creation using the OSRM Cycling engine.
  - Support for multi-mode segments (Cycling, Hiking, Direct / Straight-line, and GPX paths).
  - Rubber-band line dragging with real-time SVG drag guide overlays.
  - Priority waypoint marker dragging and smart single-click line insertions.
- **Custom Waypoint Styles**:
  - Choice of Circle, Pin, and Flag waypoint marker styles with customizable numbers.
  - High-contrast white outlines and dark charcoal styling for maximum map visibility.
  - Real-time synchronization between map markers and elevation profile graph icons.
- **Elevation Profiling & Interactive Analysis**:
  - High-precision elevation data processed via background worker threading.
  - Real-time elevation profile chart with grade color gradients and waypoint markers drawn on top.
  - Synchronized map hover dot locked to route line geometry.
- **Safety & UX Safeguards**:
  - **Long Segment Warning**: Automatic warning modal when creating/dragging segments over 250 miles (~402 km) with 1-click cancel/undo.
  - **Scroll-to-Zoom Passthrough**: Seamless mouse wheel map zooming through floating windows, top bar, and route stats panel.
  - **Smart Right-Click Gestures**: Right-click drag tracking to differentiate camera rotation/panning from context menu popups.
- **Weather & Point Inspection**: Real-time location weather forecasts and high-resolution point elevation inspection via right-click popups.
- **GPX Support**: Full import and export capability for standard GPX routes.
- **Custom Keybindings**: Fully configurable hotkeys and keyboard shortcuts for common route editing tasks.

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
- **Styling**: Vanilla CSS with modern glassmorphism aesthetics, floating panels, and dark mode support.

## License

Created by [Ion Cook](https://github.com/ioncook) using [Antigravity](https://antigravity.google).
