// Theme Management (Supports Dark, Light, and Android 12+ Material Dynamic Theme)
(function() {
    function getContrastTextColor(hexColor) {
        if (!hexColor) return '#ffffff';
        let hex = hexColor.replace('#', '');
        if (hex.length === 3) {
            hex = hex.split('').map(c => c + c).join('');
        }
        if (hex.length !== 6) return '#ffffff';
        const r = parseInt(hex.substr(0, 2), 16);
        const g = parseInt(hex.substr(2, 2), 16);
        const b = parseInt(hex.substr(4, 2), 16);
        // Relative luminance per WCAG
        const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
        return (yiq >= 140) ? '#111827' : '#f9fafb';
    }

    function adjustColorBrightness(hexColor, percent) {
        if (!hexColor) return hexColor;
        let hex = hexColor.replace('#', '');
        if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
        if (hex.length !== 6) return hexColor;
        let num = parseInt(hex, 16);
        let amt = Math.round(2.55 * percent);
        let R = (num >> 16) + amt;
        let G = (num >> 8 & 0x00FF) + amt;
        let B = (num & 0x0000FF) + amt;
        return '#' + (
            0x1000000 +
            (R < 255 ? (R < 0 ? 0 : R) : 255) * 0x10000 +
            (G < 255 ? (G < 0 ? 0 : G) : 255) * 0x100 +
            (B < 255 ? (B < 0 ? 0 : B) : 255)
        ).toString(16).slice(1);
    }

    function hexToRgba(hexColor, alpha) {
        if (!hexColor) return `rgba(255, 255, 255, ${alpha})`;
        let hex = hexColor.replace('#', '');
        if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
        if (hex.length !== 6) return `rgba(255, 255, 255, ${alpha})`;
        const r = parseInt(hex.substr(0, 2), 16);
        const g = parseInt(hex.substr(2, 2), 16);
        const b = parseInt(hex.substr(4, 2), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    function getAndroidDynamicColors() {
        if (window.AndroidMaterialTheme && typeof window.AndroidMaterialTheme.getDynamicColorsJson === 'function') {
            try {
                const jsonStr = window.AndroidMaterialTheme.getDynamicColorsJson();
                if (jsonStr) {
                    const parsed = JSON.parse(jsonStr);
                    if (parsed && (parsed.primary || parsed.surface)) {
                        return parsed;
                    }
                }
            } catch (e) {
                console.warn('Failed to parse AndroidMaterialTheme colors:', e);
            }
        }
        return null;
    }

    function clearCustomThemeStyles() {
        const customStyle = document.getElementById('material-theme-dynamic-styles');
        if (customStyle) {
            customStyle.remove();
        }
    }

    function applyMaterialTheme() {
        const root = document.documentElement;
        const colors = getAndroidDynamicColors();

        // Palette fallback if running in browser / older device
        const primary = colors?.primary || '#388E3C'; // Clean Material accent
        const surface = colors?.surface || '#1E1E1E';
        const background = colors?.background || '#121212';
        const outline = colors?.outline || '#444444';

        const onPrimary = colors?.onPrimary || getContrastTextColor(primary);
        const onSurface = colors?.onSurface || getContrastTextColor(surface);
        const onBackground = colors?.onSurface || getContrastTextColor(background);
        const primaryHover = adjustColorBrightness(primary, -15);
        const btnBg = colors?.surfaceVariant || adjustColorBrightness(surface, 10);
        const textMuted = colors?.onSurfaceVariant || hexToRgba(onSurface, 0.65);

        // Detect if overall theme is light or dark based on surface luminance / device night mode
        const isThemeLight = colors?.isNight !== undefined ? !colors.isNight : (getContrastTextColor(surface) === '#111827');
        // Safely apply light/dark classes to html and body
        root.classList.toggle('light-mode', isThemeLight);
        if (document.body) {
            document.body.classList.toggle('light-mode', isThemeLight);
        } else {
            window.addEventListener('DOMContentLoaded', () => {
                document.body.classList.toggle('light-mode', isThemeLight);
            }, { once: true });
        }

        let dynamicStyle = document.getElementById('material-theme-dynamic-styles');
        if (!dynamicStyle) {
            dynamicStyle = document.createElement('style');
            dynamicStyle.id = 'material-theme-dynamic-styles';
            (document.head || root).appendChild(dynamicStyle);
        }

        const primaryContainer = colors?.primaryContainer || adjustColorBrightness(primary, -25);
        const onPrimaryContainer = colors?.onPrimaryContainer || '#FFDBC9';

        dynamicStyle.textContent = `
            :root, html, body {
                --primary: ${primary} !important;
                --primary-hover: ${primaryHover} !important;
                --on-primary: ${onPrimary} !important;
                --primary-container: ${primaryContainer} !important;
                --on-primary-container: ${onPrimaryContainer} !important;
                --bg-dark: ${background} !important;
                --bg-panel: ${surface} !important;
                --header-bg: ${background} !important;
                --text-main: ${onSurface} !important;
                --text-muted: ${textMuted} !important;
                --border: ${outline} !important;
                --btn-bg: ${btnBg} !important;
            }
            body {
                background-color: ${background} !important;
                color: ${onSurface} !important;
            }
            #map, #map-container, .maplibregl-canvas-container, .maplibregl-canvas {
                background-color: ${background} !important;
            }
            .btn-primary {
                background-color: ${primary} !important;
                color: ${onPrimary} !important;
            }
            .btn-secondary {
                background-color: ${btnBg} !important;
                color: ${onSurface} !important;
                border-color: ${outline} !important;
            }
            #top-bar {
                background-color: ${surface} !important;
                border-bottom: 1.5px solid ${outline} !important;
            }
            #top-bar .stat-value {
                color: ${onSurface} !important;
            }
            #top-bar .stat-label {
                color: ${textMuted} !important;
            }
            #initial-map-cover {
                background-color: ${background} !important;
                color: ${onSurface} !important;
            }
            #initial-map-cover .spinner-head {
                stroke: ${primary} !important;
            }
            .settings-content, .dropdown-content {
                background-color: ${surface} !important;
                color: ${onSurface} !important;
                border-color: ${outline} !important;
            }
            .settings-header-title {
                color: ${onSurface} !important;
            }
            .settings-header {
                border-bottom-color: ${outline} !important;
            }
            .settings-close-btn {
                background: ${btnBg} !important;
                border-color: ${outline} !important;
                color: ${onSurface} !important;
            }
            .settings-content select, .settings-content input, .setting-row select, .setting-row input {
                background: ${btnBg} !important;
                color: ${onSurface} !important;
                border: 1px solid ${outline} !important;
            }
            select option {
                background-color: ${surface} !important;
                color: ${onSurface} !important;
            }
            .floating-window {
                background-color: ${surface} !important;
                border-color: ${outline} !important;
                color: ${onSurface} !important;
            }
            .window-inner {
                background-color: ${surface} !important;
                border-color: ${outline} !important;
            }
            .window-header {
                background-color: ${btnBg} !important;
                border-bottom: 1px solid ${outline} !important;
                color: ${onSurface} !important;
            }
            #elevation-panel, #stats-panel {
                background-color: ${surface} !important;
                border-color: ${outline} !important;
                color: ${onSurface} !important;
            }
            #live-nav-hud:not(.off-route-banner) {
                background-color: ${surface} !important;
                border-color: ${outline} !important;
                color: ${onSurface} !important;
            }
            #live-nav-hud:not(.off-route-banner) .live-nav-instruction-text {
                color: ${onSurface} !important;
            }
            #live-nav-hud:not(.off-route-banner) .live-nav-distance-text {
                color: ${textMuted} !important;
            }
            #live-nav-hud:not(.off-route-banner) .live-nav-turn-icon {
                background: ${primaryContainer} !important;
                border-color: ${outline} !important;
                color: ${primary} !important;
            }
            #live-nav-hud:not(.off-route-banner) .live-nav-stat-card:not(#nav-stat-grade-card) {
                background: ${btnBg} !important;
                border-color: ${outline} !important;
            }
            #live-nav-hud:not(.off-route-banner) .live-nav-stat-val {
                color: ${onSurface} !important;
            }
            #live-nav-hud:not(.off-route-banner) .live-nav-stat-label {
                color: ${textMuted} !important;
            }
            #live-nav-hud:not(.off-route-banner) .live-nav-stats-row {
                border-top-color: ${outline} !important;
            }
            #debug-joystick-container .debug-joystick-reset-btn {
                background: ${surface} !important;
                border-color: ${outline} !important;
                color: ${onSurface} !important;
            }
            #main-actions {
                background: ${surface} !important;
                border-color: ${outline} !important;
            }
            .icon-btn-group:not(.icon-btn-group-danger):not(.icon-btn-group-success) {
                background: ${btnBg} !important;
                border-color: ${outline} !important;
            }
            .icon-btn:not(#clear-route):not(#start-nav-btn) {
                color: ${onSurface} !important;
            }
            .icon-btn:not(#clear-route):not(#start-nav-btn):hover:not(:disabled) {
                background: ${btnBg} !important;
                color: ${onSurface} !important;
            }
            .icon-btn-group-danger {
                background: rgba(239, 68, 68, 0.2) !important;
                border-color: rgba(239, 68, 68, 0.45) !important;
            }
            .icon-btn-group-danger .icon-btn, #clear-route {
                color: #ef4444 !important;
            }
            #live-nav-hud.off-route-banner {
                background: linear-gradient(rgba(239, 68, 68, 0.2), rgba(239, 68, 68, 0.2)), ${surface} !important;
                border: 1px solid rgba(239, 68, 68, 0.45) !important;
                box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45) !important;
            }
            #live-nav-hud.off-route-banner .live-nav-instruction-text,
            #live-nav-hud.off-route-banner .live-nav-turn-icon,
            #live-nav-hud.off-route-banner .live-nav-stop-btn {
                color: #ef4444 !important;
            }
            #live-nav-hud.off-route-banner .live-nav-turn-icon {
                border: 1px solid rgba(239, 68, 68, 0.45) !important;
                background: linear-gradient(rgba(239, 68, 68, 0.2), rgba(239, 68, 68, 0.2)), ${btnBg} !important;
            }
            #live-nav-hud.off-route-banner .live-nav-stop-btn {
                border: 1px solid rgba(239, 68, 68, 0.45) !important;
                background: transparent !important;
            }
            #live-nav-hud.off-route-banner .live-nav-distance-text {
                color: ${textMuted} !important;
            }
            #live-nav-hud.arrive-banner {
                background: linear-gradient(rgba(34, 197, 94, 0.2), rgba(34, 197, 94, 0.2)), ${surface} !important;
                border: 1px solid rgba(34, 197, 94, 0.45) !important;
                box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45) !important;
            }
            #live-nav-hud.arrive-banner .live-nav-instruction-text,
            #live-nav-hud.arrive-banner .live-nav-turn-icon,
            #live-nav-hud.arrive-banner .live-nav-stop-btn {
                color: #22c55e !important;
            }
            #live-nav-hud.arrive-banner .live-nav-turn-icon {
                border: 1px solid rgba(34, 197, 94, 0.45) !important;
                background: linear-gradient(rgba(34, 197, 94, 0.2), rgba(34, 197, 94, 0.2)), ${btnBg} !important;
            }
            #live-nav-hud.arrive-banner .live-nav-stop-btn {
                border: 1px solid rgba(34, 197, 94, 0.45) !important;
                background: transparent !important;
            }
            #live-nav-hud.arrive-banner .live-nav-distance-text {
                color: ${textMuted} !important;
            }
            .icon-btn-group-danger:active,
            .icon-btn-group-danger:has(#clear-route:active) {
                background: #ef4444 !important;
                border-color: #ef4444 !important;
            }
            .icon-btn-group-danger:active .icon-btn,
            .icon-btn-group-danger #clear-route:active {
                color: #ffffff !important;
            }
            .icon-btn-group-success {
                background: rgba(34, 197, 94, 0.2) !important;
                border-color: rgba(34, 197, 94, 0.45) !important;
            }
            .icon-btn-group-success .icon-btn, #start-nav-btn {
                color: #22c55e !important;
            }
            .icon-btn-group-success:active,
            .icon-btn-group-success:has(#start-nav-btn:active),
            .icon-btn-group-success.nav-active {
                background: #22c55e !important;
                border-color: #16a34a !important;
            }
            .icon-btn-group-success:active .icon-btn,
            .icon-btn-group-success #start-nav-btn:active,
            .icon-btn-group-success.nav-active .icon-btn,
            .icon-btn-group-success.nav-active #start-nav-btn {
                color: #ffffff !important;
            }
            .mode-toggle {
                background: ${btnBg} !important;
                border-color: ${outline} !important;
            }
            .mode-btn.active {
                background: ${primary} !important;
                color: ${onPrimary} !important;
            }
            .zoom-warning {
                background: ${surface} !important;
                color: ${onSurface} !important;
                border-color: ${outline} !important;
            }
            #logo, #favicon-mobile {
                filter: ${isThemeLight ? 'invert(1)' : 'none'} !important;
            }
            .back-btn {
                background: ${surface} !important;
                color: ${onSurface} !important;
                border-color: ${outline} !important;
            }
            input:checked + .slider {
                background-color: ${primary} !important;
            }
            input:checked + .slider:before {
                background-color: ${onPrimary} !important;
            }
        `;
    }

    window.applyAppTheme = function(themeName) {
        if (themeName === 'material') {
            applyMaterialTheme();
        } else {
            clearCustomThemeStyles();
            const isLight = themeName === 'light';
            document.documentElement.classList.toggle('light-mode', isLight);
            if (document.body) {
                document.body.classList.toggle('light-mode', isLight);
            } else {
                window.addEventListener('DOMContentLoaded', () => {
                    document.body.classList.toggle('light-mode', isLight);
                }, { once: true });
            }
        }
    };

    // Apply stored theme immediately on evaluation
    const stored = localStorage.getItem('route_theme') || 'dark';
    window.applyAppTheme(stored);
})();
