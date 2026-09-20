import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { View, StyleSheet } from 'react-native';

export type Region = {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
};

export type MapPressEvent = {
  nativeEvent: { coordinate: { latitude: number; longitude: number } };
};

export type AppMapViewProps = {
  style?: any;
  initialRegion?: Region;
  region?: Region;
  mapType?: string;
  onRegionChangeComplete?: (region: Region) => void;
  onPress?: (event: MapPressEvent) => void;
  children?: React.ReactNode;
  [key: string]: any;
};

export type MarkerProps = {
  coordinate: { latitude: number; longitude: number };
  title?: string;
  description?: string;
  pinColor?: string;
  draggable?: boolean;
  label?: string | number;
  onPress?: (event: any) => void;
  onDragStart?: (event?: any) => void;
  onDragEnd?: (event: any) => void;
  children?: React.ReactNode;
  [key: string]: any;
};

export type PolygonProps = {
  coordinates: Array<{ latitude: number; longitude: number }>;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  onPress?: () => void;
  [key: string]: any;
};

// These render nothing on web — AppMapView reads their props from children.
export function Marker(_props: MarkerProps) {
  return null;
}
export function Polygon(_props: PolygonProps) {
  return null;
}
export function Callout(_props: any) {
  return null;
}

// --- Leaflet loader (from cdnjs, once) --------------------------------------
let leafletPromise: Promise<any> | null = null;
function loadLeaflet(): Promise<any> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if ((window as any).L) return Promise.resolve((window as any).L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    const cssId = 'leaflet-css';
    if (!document.getElementById(cssId)) {
      const css = document.createElement('link');
      css.id = cssId;
      css.rel = 'stylesheet';
      css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
      document.head.appendChild(css);
    }
    const js = document.createElement('script');
    js.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    js.async = true;
    js.onload = () => resolve((window as any).L);
    js.onerror = () => reject(new Error('leaflet load failed'));
    document.head.appendChild(js);
  });
  return leafletPromise;
}

function zoomForDelta(latDelta: number): number {
  const z = Math.log2(360 / Math.max(latDelta || 0.05, 0.0006));
  return Math.max(3, Math.min(18, Math.round(z)));
}

const AppMapView = forwardRef<any, AppMapViewProps>(function AppMapView(props, ref) {
  const { style, initialRegion, region: controlledRegion, onPress, children } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const overlayRef = useRef<any>(null);
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;

  const region0 = controlledRegion ||
    initialRegion || {
      latitude: 51.62,
      longitude: 70.18,
      latitudeDelta: 0.05,
      longitudeDelta: 0.05,
    };

  // Parse child <Polygon>/<Marker> into plain prop objects.
  const { polygons, markers } = useMemo(() => {
    const polys: PolygonProps[] = [];
    const marks: MarkerProps[] = [];
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return;
      if (child.type === Polygon) polys.push(child.props as PolygonProps);
      else if (child.type === Marker) marks.push(child.props as MarkerProps);
    });
    return { polygons: polys, markers: marks };
  }, [children]);

  const drawOverlays = (L: any) => {
    const group = overlayRef.current;
    if (!group) return;
    group.clearLayers();

    polygons.forEach((p) => {
      if (!p.coordinates || p.coordinates.length < 3) return;
      const latlngs = p.coordinates.map((c) => [c.latitude, c.longitude]);
      const poly = L.polygon(latlngs, {
        color: p.strokeColor || '#10B981',
        weight: p.strokeWidth || 2,
        fillColor: p.fillColor || '#10B981',
        fillOpacity: 0.28,
      }).addTo(group);
      if (p.onPress) poly.on('click', () => p.onPress?.());
    });

    markers.forEach((m) => {
      const pos: [number, number] = [m.coordinate.latitude, m.coordinate.longitude];
      const isVertex = m.label != null || m.draggable;
      if (isVertex) {
        const html = `<div style="width:26px;height:26px;border-radius:50%;background:${
          m.pinColor || '#1B5E20'
        };border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:700;font-family:Montserrat,sans-serif;">${
          m.label != null ? String(m.label) : ''
        }</div>`;
        const icon = L.divIcon({ html, className: '', iconSize: [26, 26], iconAnchor: [13, 13] });
        const mk = L.marker(pos, { icon, draggable: !!m.draggable }).addTo(group);
        if (m.onPress) {
          mk.on('click', (e: any) => {
            if (L.DomEvent) L.DomEvent.stopPropagation(e);
            m.onPress?.({ stopPropagation() {}, nativeEvent: { coordinate: { latitude: pos[0], longitude: pos[1] } } });
          });
        }
        if (m.onDragStart) mk.on('dragstart', () => m.onDragStart?.());
        if (m.onDragEnd) {
          mk.on('dragend', (e: any) => {
            const ll = e.target.getLatLng();
            m.onDragEnd?.({ nativeEvent: { coordinate: { latitude: ll.lat, longitude: ll.lng } } });
          });
        }
      } else {
        const html = `<div style="display:flex;flex-direction:column;align-items:center;transform:translateY(-6px);">
          <div style="width:14px;height:14px;border-radius:50%;background:${m.pinColor || '#EF4444'};border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);"></div>
          ${m.title ? `<span style="margin-top:2px;padding:1px 5px;border-radius:4px;background:rgba(0,0,0,.72);color:#fff;font-size:10px;font-family:Montserrat,sans-serif;white-space:nowrap;">${m.title}</span>` : ''}
        </div>`;
        const icon = L.divIcon({ html, className: '', iconSize: [14, 26], iconAnchor: [7, 13] });
        L.marker(pos, { icon, interactive: false }).addTo(group);
      }
    });
  };

  // Initialise the Leaflet map once.
  useEffect(() => {
    let cancelled = false;
    loadLeaflet()
      .then((L) => {
        if (cancelled || !containerRef.current || mapRef.current) return;
        const map = L.map(containerRef.current, {
          zoomControl: true,
          attributionControl: true,
          tap: true,
        }).setView([region0.latitude, region0.longitude], zoomForDelta(region0.latitudeDelta));

        L.tileLayer(
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          { maxZoom: 19, attribution: 'Esri · Maxar · Earthstar Geographics' },
        ).addTo(map);

        overlayRef.current = L.layerGroup().addTo(map);
        map.on('click', (e: any) => {
          onPressRef.current?.({
            nativeEvent: { coordinate: { latitude: e.latlng.lat, longitude: e.latlng.lng } },
          });
        });
        mapRef.current = map;
        drawOverlays(L);
        setTimeout(() => map.invalidateSize(), 60);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        overlayRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw overlays whenever polygons/markers change.
  useEffect(() => {
    const L = (window as any).L;
    if (L && mapRef.current && overlayRef.current) drawOverlays(L);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polygons, markers]);

  useImperativeHandle(ref, () => ({
    animateToRegion: (nextRegion: Region) => {
      mapRef.current?.setView(
        [nextRegion.latitude, nextRegion.longitude],
        zoomForDelta(nextRegion.latitudeDelta),
      );
    },
    fitToCoordinates: (
      coordinates: Array<{ latitude: number; longitude: number }>,
      _options?: unknown,
    ) => {
      const L = (window as any).L;
      if (!L || !mapRef.current || !coordinates?.length) return;
      const bounds = L.latLngBounds(coordinates.map((c) => [c.latitude, c.longitude]));
      mapRef.current.fitBounds(bounds, { padding: [28, 28], maxZoom: 17 });
    },
  }));

  return (
    <View style={[styles.container, style]}>
      <div ref={containerRef} style={{ width: '100%', height: '100%', background: '#0F172A' }} />
    </View>
  );
});

export default AppMapView;

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    backgroundColor: '#0F172A',
  },
});
