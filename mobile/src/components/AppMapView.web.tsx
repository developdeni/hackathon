import React, { forwardRef, useImperativeHandle, useMemo, useState } from 'react';
import { View, StyleSheet, Text, Pressable } from 'react-native';

export type Region = {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
};

export type MapPressEvent = {
  nativeEvent: {
    coordinate: {
      latitude: number;
      longitude: number;
    };
  };
};

export type AppMapViewProps = {
  style?: any;
  initialRegion?: Region;
  region?: Region;
  mapType?: string;
  onRegionChangeComplete?: (region: Region) => void;
  onPress?: (event: MapPressEvent) => void;
  children?: React.ReactNode;
};

export type MarkerProps = {
  coordinate: { latitude: number; longitude: number };
  title?: string;
  description?: string;
  pinColor?: string;
  children?: React.ReactNode;
};

export type PolygonProps = {
  coordinates: Array<{ latitude: number; longitude: number }>;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
};

export function Marker(_props: MarkerProps) {
  return null;
}

export function Polygon(_props: PolygonProps) {
  return null;
}

export function Callout(_props: any) {
  return null;
}

const AppMapView = forwardRef<any, AppMapViewProps>(function AppMapView(props, ref) {
  const { style, initialRegion, region: controlledRegion, onPress, children } = props;
  const currentRegion = controlledRegion || initialRegion || {
    latitude: 51.62,
    longitude: 70.18,
    latitudeDelta: 0.05,
    longitudeDelta: 0.05,
  };

  const [region, setRegion] = useState<Region>(currentRegion);

  useImperativeHandle(ref, () => ({
    animateToRegion: (nextRegion: Region) => {
      setRegion(nextRegion);
      props.onRegionChangeComplete?.(nextRegion);
    },
  }));

  // Parse children to find Polygons and Markers
  const { polygons, markers } = useMemo(() => {
    const polys: PolygonProps[] = [];
    const marks: MarkerProps[] = [];

    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return;
      if (child.type === Polygon) {
        polys.push(child.props as PolygonProps);
      } else if (child.type === Marker) {
        marks.push(child.props as MarkerProps);
      }
    });

    return { polygons: polys, markers: marks };
  }, [children]);

  // Project lat/lng to [0..100]% within current region bounding box
  const minLat = region.latitude - region.latitudeDelta / 2;
  const maxLat = region.latitude + region.latitudeDelta / 2;
  const minLng = region.longitude - region.longitudeDelta / 2;
  const maxLng = region.longitude + region.longitudeDelta / 2;

  const latToY = (lat: number) => {
    const range = maxLat - minLat || 0.001;
    return ((maxLat - lat) / range) * 100;
  };

  const lngToX = (lng: number) => {
    const range = maxLng - minLng || 0.001;
    return ((lng - minLng) / range) * 100;
  };

  const handleContainerPress = (e: any) => {
    if (!onPress) return;
    const rect = e.currentTarget?.getBoundingClientRect?.();
    if (!rect) return;
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const normX = Math.max(0, Math.min(1, clickX / rect.width));
    const normY = Math.max(0, Math.min(1, clickY / rect.height));

    const clickedLng = minLng + normX * (maxLng - minLng);
    const clickedLat = maxLat - normY * (maxLat - minLat);

    onPress({
      nativeEvent: {
        coordinate: {
          latitude: clickedLat,
          longitude: clickedLng,
        },
      },
    });
  };

  return (
    <View style={[styles.container, style]}>
      {/* Interactive SVG Field Canvas */}
      <div
        onClick={handleContainerPress}
        style={{
          width: '100%',
          height: '100%',
          position: 'relative',
          backgroundColor: '#131D15',
          backgroundImage: `
            radial-gradient(circle at 50% 50%, rgba(16, 185, 129, 0.08) 0%, transparent 80%),
            linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)
          `,
          backgroundSize: '100% 100%, 24px 24px, 24px 24px',
          overflow: 'hidden',
          cursor: onPress ? 'crosshair' : 'default',
        }}
      >
        <svg
          style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          {/* Polygons */}
          {polygons.map((poly, idx) => {
            if (!poly.coordinates || poly.coordinates.length < 3) return null;
            const points = poly.coordinates
              .map((c) => `${lngToX(c.longitude)},${latToY(c.latitude)}`)
              .join(' ');
            return (
              <polygon
                key={idx}
                points={points}
                fill={poly.fillColor || 'rgba(16, 185, 129, 0.35)'}
                stroke={poly.strokeColor || '#10B981'}
                strokeWidth={poly.strokeWidth ? poly.strokeWidth * 0.4 : 0.8}
                strokeLinejoin="round"
              />
            );
          })}
        </svg>

        {/* Markers */}
        {markers.map((marker, idx) => {
          const x = lngToX(marker.coordinate.longitude);
          const y = latToY(marker.coordinate.latitude);
          return (
            <div
              key={idx}
              style={{
                position: 'absolute',
                left: `${x}%`,
                top: `${y}%`,
                transform: 'translate(-50%, -100%)',
                pointerEvents: 'none',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
              }}
            >
              <div
                style={{
                  background: marker.pinColor || '#EF4444',
                  width: '12px',
                  height: '12px',
                  borderRadius: '50%',
                  border: '2px solid #FFFFFF',
                  boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
                }}
              />
              {marker.title && (
                <span
                  style={{
                    color: '#FFFFFF',
                    fontSize: '10px',
                    fontFamily: 'Montserrat, sans-serif',
                    background: 'rgba(0,0,0,0.7)',
                    padding: '1px 4px',
                    borderRadius: '4px',
                    marginTop: '2px',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {marker.title}
                </span>
              )}
            </div>
          );
        })}

        {/* Web Satellite Overlay Badge */}
        <div
          style={{
            position: 'absolute',
            bottom: '8px',
            right: '8px',
            background: 'rgba(7, 8, 11, 0.75)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '6px',
            padding: '4px 8px',
            fontSize: '10px',
            color: '#9CA3AF',
            fontFamily: 'Montserrat, sans-serif',
            pointerEvents: 'none',
          }}
        >
          🛰 Sentinel-2 L2A Web View
        </div>
      </div>
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
