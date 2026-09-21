import React, {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

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
  onPress?: (event: MapPressEvent) => void;
  onGestureActiveChange?: (active: boolean) => void;
  children?: React.ReactNode;
  [key: string]: any;
};

export type MarkerProps = {
  coordinate: { latitude: number; longitude: number };
  title?: string;
  pinColor?: string;
  draggable?: boolean;
  label?: string | number;
  onPress?: (event: any) => void;
  onDragEnd?: (event: any) => void;
  onDragStart?: (event?: any) => void;
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

// Render nothing — AppMapView reads their props from children.
export function Marker(_props: MarkerProps) {
  return null;
}
export function Polygon(_props: PolygonProps) {
  return null;
}
export function Callout(_props: any) {
  return null;
}

function zoomForDelta(latDelta: number): number {
  const z = Math.log2(360 / Math.max(latDelta || 0.05, 0.0006));
  return Math.max(3, Math.min(18, Math.round(z)));
}

// Self-contained Leaflet page (Esri World Imagery — no Google Maps, no API key).
function buildHtml(center: [number, number], zoom: number): string {
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"/>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"/>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<style>html,body,#map{height:100%;margin:0;background:#0F172A;}</style>
</head><body><div id="map"></div>
<script>
(function(){
  function post(m){ if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(m)); }
  function start(){
    if(!window.L){ setTimeout(start,60); return; }
    var map = L.map('map',{zoomControl:true, attributionControl:true}).setView(${JSON.stringify(center)}, ${zoom});
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:19, attribution:'Esri · Maxar · Earthstar Geographics'}).addTo(map);
    var group = L.layerGroup().addTo(map);
    map.on('click', function(e){ post({type:'press', lat:e.latlng.lat, lng:e.latlng.lng}); });
    // Signal RN the moment a finger lands on the map, so the parent ScrollView
    // can release the gesture and let the map pan instead of scrolling the screen.
    var el = map.getContainer();
    el.addEventListener('touchstart', function(){ post({type:'gesture', active:true}); }, {passive:true});
    el.addEventListener('touchend', function(){ post({type:'gesture', active:false}); }, {passive:true});
    el.addEventListener('touchcancel', function(){ post({type:'gesture', active:false}); }, {passive:true});
    window.__apply = function(polys, marks){
      group.clearLayers();
      (polys||[]).forEach(function(p){
        if(!p.coordinates || p.coordinates.length<3) return;
        var ll = p.coordinates.map(function(c){return [c.latitude,c.longitude];});
        L.polygon(ll,{color:p.strokeColor||'#10B981', weight:p.strokeWidth||2, fillColor:p.fillColor||'#10B981', fillOpacity:0.28}).addTo(group);
      });
      (marks||[]).forEach(function(m){
        var pos=[m.latitude,m.longitude];
        if(m.label!=null || m.draggable){
          var html='<div style="width:26px;height:26px;border-radius:50%;background:'+(m.pinColor||'#1B5E20')+';border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:700;font-family:sans-serif;">'+(m.label!=null?m.label:'')+'</div>';
          var icon=L.divIcon({html:html, className:'', iconSize:[26,26], iconAnchor:[13,13]});
          var mk=L.marker(pos,{icon:icon, draggable:!!m.draggable}).addTo(group);
          mk.on('click', function(e){ if(L.DomEvent) L.DomEvent.stopPropagation(e); post({type:'markerPress', id:m.id}); });
          mk.on('dragstart', function(){ post({type:'dragStart', id:m.id}); });
          mk.on('dragend', function(e){ var ll=e.target.getLatLng(); post({type:'dragEnd', id:m.id, lat:ll.lat, lng:ll.lng}); });
        } else {
          var h='<div style="display:flex;flex-direction:column;align-items:center;transform:translateY(-6px);"><div style="width:14px;height:14px;border-radius:50%;background:'+(m.pinColor||'#EF4444')+';border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);"></div>'+(m.title?'<span style="margin-top:2px;padding:1px 5px;border-radius:4px;background:rgba(0,0,0,.72);color:#fff;font-size:10px;white-space:nowrap;">'+m.title+'</span>':'')+'</div>';
          L.marker(pos,{icon:L.divIcon({html:h, className:'', iconSize:[14,26], iconAnchor:[7,13]}), interactive:false}).addTo(group);
        }
      });
    };
    window.__setView = function(lat,lng,z){ map.setView([lat,lng], z); };
    window.__fit = function(coords){ if(!coords||!coords.length) return; map.fitBounds(coords.map(function(c){return [c.latitude,c.longitude];}), {padding:[28,28], maxZoom:17}); };
    setTimeout(function(){ map.invalidateSize(); }, 80);
    post({type:'ready'});
  }
  start();
})();
</script></body></html>`;
}

const AppMapView = forwardRef<any, AppMapViewProps>(function AppMapView(props, ref) {
  const { style, initialRegion, region: controlledRegion, onPress, onGestureActiveChange, children } = props;
  const webRef = useRef<WebView>(null);
  const readyRef = useRef(false);

  const region0 = controlledRegion ||
    initialRegion || {
      latitude: 51.62,
      longitude: 70.18,
      latitudeDelta: 0.05,
      longitudeDelta: 0.05,
    };

  const html = useMemo(
    () => buildHtml([region0.latitude, region0.longitude], zoomForDelta(region0.latitudeDelta)),
    // Build once with the initial view; later updates go through imperative handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Parse children into serialisable overlay data; keep marker callbacks by id.
  const { polygons, markers, markerMap } = useMemo(() => {
    const polys: any[] = [];
    const marks: any[] = [];
    const map: Record<string, MarkerProps> = {};
    let i = 0;
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return;
      if (child.type === Polygon) {
        const p = child.props as PolygonProps;
        polys.push({
          coordinates: p.coordinates,
          fillColor: p.fillColor,
          strokeColor: p.strokeColor,
          strokeWidth: p.strokeWidth,
        });
      } else if (child.type === Marker) {
        const m = child.props as MarkerProps;
        const id = `m${i++}`;
        map[id] = m;
        marks.push({
          id,
          latitude: m.coordinate.latitude,
          longitude: m.coordinate.longitude,
          label: m.label ?? null,
          pinColor: m.pinColor,
          draggable: !!m.draggable,
          title: m.title,
        });
      }
    });
    return { polygons: polys, markers: marks, markerMap: map };
  }, [children]);

  const pushOverlays = () => {
    if (!readyRef.current || !webRef.current) return;
    const js = `window.__apply && window.__apply(${JSON.stringify(polygons)}, ${JSON.stringify(markers)}); true;`;
    webRef.current.injectJavaScript(js);
  };

  // Re-push overlays whenever they change (after ready).
  React.useEffect(() => {
    pushOverlays();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polygons, markers]);

  const handleMessage = (event: WebViewMessageEvent) => {
    let data: any;
    try {
      data = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (data.type === 'ready') {
      readyRef.current = true;
      pushOverlays();
    } else if (data.type === 'gesture') {
      onGestureActiveChange?.(!!data.active);
    } else if (data.type === 'press') {
      onPress?.({ nativeEvent: { coordinate: { latitude: data.lat, longitude: data.lng } } });
    } else if (data.type === 'markerPress') {
      markerMap[data.id]?.onPress?.({ stopPropagation() {}, nativeEvent: { coordinate: { latitude: markerMap[data.id].coordinate.latitude, longitude: markerMap[data.id].coordinate.longitude } } });
    } else if (data.type === 'dragStart') {
      markerMap[data.id]?.onDragStart?.();
    } else if (data.type === 'dragEnd') {
      markerMap[data.id]?.onDragEnd?.({ nativeEvent: { coordinate: { latitude: data.lat, longitude: data.lng } } });
    }
  };

  useImperativeHandle(ref, () => ({
    animateToRegion: (next: Region) => {
      webRef.current?.injectJavaScript(
        `window.__setView && window.__setView(${next.latitude}, ${next.longitude}, ${zoomForDelta(next.latitudeDelta)}); true;`,
      );
    },
    fitToCoordinates: (coordinates: Array<{ latitude: number; longitude: number }>) => {
      webRef.current?.injectJavaScript(
        `window.__fit && window.__fit(${JSON.stringify(coordinates || [])}); true;`,
      );
    },
  }));

  return (
    <View style={[styles.container, style]}>
      <WebView
        ref={webRef}
        originWhitelist={['*']}
        source={{ html }}
        onMessage={handleMessage}
        javaScriptEnabled
        domStorageEnabled
        style={styles.web}
        androidLayerType="hardware"
      />
    </View>
  );
});

export default AppMapView;

const styles = StyleSheet.create({
  container: { overflow: 'hidden', backgroundColor: '#0F172A' },
  web: { flex: 1, backgroundColor: '#0F172A' },
});
