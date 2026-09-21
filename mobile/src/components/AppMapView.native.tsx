import React, { forwardRef, type ComponentType } from 'react';
import RNMapView, { Marker as RNMarker, Polygon, Callout } from 'react-native-maps';
import type { MapMarkerProps, MapPressEvent, MapViewProps, Region } from 'react-native-maps';

type AppMapViewProps = MapViewProps & {
  onGestureActiveChange?: (active: boolean) => void;
};

const AppMapView = forwardRef<RNMapView, AppMapViewProps>(function AppMapView(
  { onGestureActiveChange: _onGestureActiveChange, ...props },
  ref,
) {
  return <RNMapView ref={ref} {...props} />;
});

// Widen Marker props with the cross-platform `label` used by the web/android maps
// (react-native-maps ignores it at runtime; the web/android maps render it).
const Marker = RNMarker as unknown as ComponentType<
  MapMarkerProps & { label?: string | number }
>;

export default AppMapView;
export { Marker, Polygon, Callout };
export type { MapPressEvent, Region };
