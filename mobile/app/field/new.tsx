import { ComponentProps, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { Text, TextInput } from '../../src/components/AppText';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Location from 'expo-location';
import MapView, { MapPressEvent, Marker, Polygon, Region } from 'react-native-maps';

import { Card } from '../../src/components/Card';
import { Screen } from '../../src/components/Screen';
import { createField, detectFieldBoundary, getField, updateField } from '../../src/services/api';
import { colors } from '../../src/theme/colors';
import { fontFamilies } from '../../src/theme/typography';
import { Coordinate, Field } from '../../src/types/domain';

const DEFAULT_CENTER: Coordinate = { latitude: 53.283, longitude: 69.38 };
const DEFAULT_WIDTH_M = 800;
const DEFAULT_HEIGHT_M = 600;
const MIN_SIZE_M = 20;
const CROP_SUGGESTIONS = ['Яровая пшеница', 'Ячмень', 'Рапс', 'Подсолнечник', 'Картофель', 'Овёс'];

export default function NewFieldScreen() {
  const router = useRouter();
  const mapRef = useRef<MapView>(null);
  const { profileId, fieldId } = useLocalSearchParams<{ profileId?: string; fieldId?: string }>();
  const isEditing = Boolean(fieldId);

  const [name, setName] = useState('');
  const [cropType, setCropType] = useState('');
  const [centerLat, setCenterLat] = useState(formatCoord(DEFAULT_CENTER.latitude));
  const [centerLng, setCenterLng] = useState(formatCoord(DEFAULT_CENTER.longitude));
  const [widthMeters, setWidthMeters] = useState(String(DEFAULT_WIDTH_M));
  const [heightMeters, setHeightMeters] = useState(String(DEFAULT_HEIGHT_M));
  const [boundary, setBoundary] = useState<Coordinate[]>(buildRectangle(DEFAULT_CENTER, DEFAULT_WIDTH_M, DEFAULT_HEIGHT_M));
  const [loading, setLoading] = useState(Boolean(fieldId));
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [segmenting, setSegmenting] = useState(false);
  const [editMode, setEditMode] = useState<'move' | 'corners'>('corners');
  const [activeCorner, setActiveCorner] = useState<number | null>(null);

  useEffect(() => {
    if (!fieldId) return;
    const requestedFieldId = fieldId;
    let mounted = true;
    async function loadField() {
      setLoading(true);
      try {
        const field = await getField(requestedFieldId);
        if (mounted) applyField(field);
      } catch (error) {
        Alert.alert('Участок не загружен', error instanceof Error ? error.message : 'Повторите попытку.');
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void loadField();
    return () => {
      mounted = false;
    };
  }, [fieldId]);

  const estimatedHa = useMemo(() => computeAreaHa(boundary), [boundary]);
  const estimatedPerimeterKm = useMemo(() => computePerimeterKm(boundary), [boundary]);
  const mapRegion = useMemo(() => regionFromBoundary(boundary), [boundary]);

  function applyField(field: Field) {
    const nextBoundary = normalizeBoundary(field.boundary);
    const bounds = getBounds(nextBoundary);
    const size = estimateWidthHeight(nextBoundary);
    setName(field.name);
    setCropType(field.cropType);
    setCenterLat(formatCoord(bounds.center.latitude));
    setCenterLng(formatCoord(bounds.center.longitude));
    setWidthMeters(String(Math.round(size.widthM)));
    setHeightMeters(String(Math.round(size.heightM)));
    setBoundary(nextBoundary);
  }

  function rebuildFromCenterAndSize() {
    const parsedCenter = parseCenter(centerLat, centerLng);
    const width = parseMeters(widthMeters);
    const height = parseMeters(heightMeters);
    if (!parsedCenter || width === null || height === null) {
      Alert.alert('Проверьте значения', 'Введите центр, ширину и длину числами.');
      return;
    }
    const nextBoundary = buildRectangle(parsedCenter, width, height);
    setBoundary(nextBoundary);
    mapRef.current?.animateToRegion(regionFromBoundary(nextBoundary), 250);
  }

  function handleMapPress(event: MapPressEvent) {
    if (editMode === 'move') {
      const nextCenter = event.nativeEvent.coordinate;
      setCenterLat(formatCoord(nextCenter.latitude));
      setCenterLng(formatCoord(nextCenter.longitude));
      const width = parseMeters(widthMeters) ?? DEFAULT_WIDTH_M;
      const height = parseMeters(heightMeters) ?? DEFAULT_HEIGHT_M;
      setBoundary(buildRectangle(nextCenter, width, height));
      return;
    }
    if (editMode === 'corners' && activeCorner !== null) {
      updateCorner(activeCorner, event.nativeEvent.coordinate);
    }
  }

  function updateCorner(index: number, point: Coordinate) {
    setBoundary((current) => {
      const next = [...current];
      next[index] = point;
      syncMetaFromBoundary(next);
      return next;
    });
  }

  function centerContour() {
    if (boundary.length < 3) return;
    mapRef.current?.fitToCoordinates(boundary, {
      edgePadding: { top: 40, right: 40, bottom: 40, left: 40 },
      animated: true,
    });
  }

  function alignToRectangle() {
    const bounds = getBounds(boundary);
    const size = estimateWidthHeight(boundary);
    const next = buildRectangle(bounds.center, size.widthM, size.heightM);
    setBoundary(next);
    syncMetaFromBoundary(next);
    mapRef.current?.animateToRegion(regionFromBoundary(next), 250);
  }

  async function autoBoundaryFromSatellite() {
    if (segmenting) return;
    const center = parseCenter(centerLat, centerLng) ?? getBounds(boundary).center;
    const size = estimateWidthHeight(boundary);
    setSegmenting(true);
    try {
      const result = await detectFieldBoundary({
        latitude: center.latitude,
        longitude: center.longitude,
        radiusMeters: Math.max(size.widthM, size.heightM) * 0.75,
      });
      const nextBoundary = normalizeBoundary(result.boundary);
      setBoundary(nextBoundary);
      syncMetaFromBoundary(nextBoundary);
      mapRef.current?.animateToRegion(regionFromBoundary(nextBoundary), 300);
      Alert.alert(
        'Автоконтур построен',
        `Sentinel-2 нашёл границу пашни. Уверенность: ${(result.confidence * 100).toFixed(0)}%. Проверьте углы перед сохранением.`,
      );
    } catch (error) {
      Alert.alert(
        'Автоконтур недоступен',
        error instanceof Error ? error.message : 'Не удалось выделить поле по снимку.',
      );
    } finally {
      setSegmenting(false);
    }
  }

  function updateCornerText(index: number, key: keyof Coordinate, value: string) {
    const numeric = Number(value.replace(',', '.'));
    if (!Number.isFinite(numeric)) return;
    setBoundary((current) => {
      const next = [...current];
      next[index] = { ...next[index], [key]: numeric };
      syncMetaFromBoundary(next);
      return next;
    });
  }

  function syncMetaFromBoundary(nextBoundary: Coordinate[]) {
    const bounds = getBounds(nextBoundary);
    const size = estimateWidthHeight(nextBoundary);
    setCenterLat(formatCoord(bounds.center.latitude));
    setCenterLng(formatCoord(bounds.center.longitude));
    setWidthMeters(String(Math.round(size.widthM)));
    setHeightMeters(String(Math.round(size.heightM)));
  }

  async function useGPS() {
    setLocating(true);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Геопозиция не получена', 'Можно ввести координаты центра вручную.');
        return;
      }
      const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const nextCenter = { latitude: location.coords.latitude, longitude: location.coords.longitude };
      setCenterLat(formatCoord(nextCenter.latitude));
      setCenterLng(formatCoord(nextCenter.longitude));
      const nextBoundary = buildRectangle(nextCenter, parseMeters(widthMeters) ?? DEFAULT_WIDTH_M, parseMeters(heightMeters) ?? DEFAULT_HEIGHT_M);
      setBoundary(nextBoundary);
      mapRef.current?.animateToRegion(regionFromBoundary(nextBoundary), 400);
    } catch {
      Alert.alert('Ошибка GPS', 'Не удалось получить координаты.');
    } finally {
      setLocating(false);
    }
  }

  async function save() {
    if (saving) return;
    if (name.trim().length < 2 || cropType.trim().length < 2) {
      Alert.alert('Заполните данные', 'Введите название участка и культуру.');
      return;
    }
    if (boundary.length < 3 || boundary.some((point) => !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude))) {
      Alert.alert('Проверьте контур', 'В контуре должны быть корректные координаты углов.');
      return;
    }
    if (!isEditing && !profileId) {
      Alert.alert('Профиль не выбран', 'Вернитесь и выберите профиль.');
      return;
    }
    setSaving(true);
    try {
      const payload = { name: name.trim(), cropType: cropType.trim(), boundary };
      const field = isEditing && fieldId
        ? await updateField(fieldId, payload)
        : await createField({ profileId: profileId as string, ...payload });
      router.replace({ pathname: '/field/[id]', params: { id: field.id } });
    } catch (error) {
      Alert.alert('Не сохранено', error instanceof Error ? error.message : 'Повторите попытку.');
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Screen contentStyle={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>Загрузка участка…</Text>
      </Screen>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen contentStyle={styles.content}>
        <View style={styles.titleBlock}>
          <Text style={styles.title}>{isEditing ? 'Редактировать участок' : 'Новый участок'}</Text>
          <Text style={styles.subtitle}>Двигайте углы на карте или вводите координаты и размеры вручную.</Text>
        </View>

        <Card style={styles.formCard}>
          <FieldInput label="Название" value={name} onChangeText={setName} placeholder="Поле №12 «Западное»" />
          <View style={styles.divider} />
          <FieldInput label="Культура" value={cropType} onChangeText={setCropType} placeholder="Пшеница, рапс, картофель…" />
        </Card>

        <View style={styles.suggestions}>
          {CROP_SUGGESTIONS.map((crop) => (
            <Pressable
              key={crop}
              onPress={() => setCropType(crop)}
              style={({ pressed }) => [styles.chip, cropType === crop && styles.chipActive, pressed && styles.pressed]}
            >
              <Text style={[styles.chipText, cropType === crop && styles.chipTextActive]} numberOfLines={1}>
                {crop}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.modeSwitchWrap}>
          <Pressable
            onPress={() => {
              setEditMode('move');
              setActiveCorner(null);
            }}
            style={[styles.modeTab, editMode === 'move' && styles.modeTabActive]}
          >
            <Text style={[styles.modeTabText, editMode === 'move' && styles.modeTabTextActive]} numberOfLines={1}>
              Контур целиком
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setEditMode('corners')}
            style={[styles.modeTab, editMode === 'corners' && styles.modeTabActive]}
          >
            <Text style={[styles.modeTabText, editMode === 'corners' && styles.modeTabTextActive]} numberOfLines={1}>
              Углы
            </Text>
          </Pressable>
        </View>
        <Text style={styles.modeHint}>
          {editMode === 'move'
            ? 'Тап по карте переносит весь контур в новую точку.'
            : activeCorner === null
            ? 'Нажмите на пронумерованный маркер, затем на карту — угол переместится туда. Либо перетащите маркер.'
            : `Угол ${activeCorner + 1} выбран — нажмите на карту, куда его перенести.`}
        </Text>

        <View style={styles.mapFrame}>
          {Platform.OS === 'web' ? (
            <View style={styles.mapFallback}>
              <Text style={styles.mapFallbackText}>Карта доступна на iPhone</Text>
            </View>
          ) : (
            <MapView
              ref={mapRef}
              style={styles.map}
              initialRegion={mapRegion}
              onPress={handleMapPress}
              showsUserLocation
              showsMyLocationButton={false}
            >
              <Polygon coordinates={boundary} fillColor="rgba(27, 94, 32, 0.16)" strokeColor={colors.primary} strokeWidth={2} />
              {boundary.map((point, index) => (
                <Marker
                  key={`corner-${index}`}
                  coordinate={point}
                  draggable={editMode === 'corners'}
                  hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
                  tracksViewChanges
                  anchor={{ x: 0.5, y: 0.5 }}
                  onPress={(event) => {
                    event.stopPropagation();
                    if (editMode === 'corners') setActiveCorner(index);
                  }}
                  onDragStart={() => setActiveCorner(index)}
                  onDragEnd={(event) => {
                    updateCorner(index, event.nativeEvent.coordinate);
                  }}
                >
                  <View style={styles.cornerMarker}>
                    <View style={[styles.cornerMarkerInner, activeCorner === index && styles.cornerMarkerInnerActive]}>
                      <Text style={styles.cornerMarkerText}>{index + 1}</Text>
                    </View>
                  </View>
                </Marker>
              ))}
            </MapView>
          )}
          <View style={styles.mapInfo}>
            <Text style={styles.mapInfoText} numberOfLines={2}>
              {estimatedHa.toFixed(2)} га • периметр {estimatedPerimeterKm.toFixed(2)} км
            </Text>
          </View>
        </View>

        <View style={styles.actionsRow}>
          <Pressable onPress={centerContour} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}>
            <Text style={styles.secondaryButtonText}>Центрировать контур</Text>
          </Pressable>
          <Pressable onPress={alignToRectangle} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}>
            <Text style={styles.secondaryButtonText}>Выровнять в прямоугольник</Text>
          </Pressable>
        </View>

        <Pressable
          disabled={segmenting}
          onPress={() => void autoBoundaryFromSatellite()}
          style={({ pressed }) => [styles.segmentButton, (pressed || segmenting) && styles.pressed]}
        >
          {segmenting ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={styles.segmentButtonText}>Автоконтур по снимку Sentinel-2</Text>
          )}
        </Pressable>

        <Card style={styles.formCard}>
          <View style={styles.twoCols}>
            <FieldInput label="Центр lat" value={centerLat} onChangeText={setCenterLat} keyboardType="decimal-pad" compact />
            <FieldInput label="Центр lng" value={centerLng} onChangeText={setCenterLng} keyboardType="decimal-pad" compact />
          </View>
          <View style={styles.divider} />
          <View style={styles.twoCols}>
            <FieldInput label="Ширина, м" value={widthMeters} onChangeText={setWidthMeters} keyboardType="decimal-pad" compact />
            <FieldInput label="Длина, м" value={heightMeters} onChangeText={setHeightMeters} keyboardType="decimal-pad" compact />
          </View>
        </Card>

        <View style={styles.actionsRow}>
          <Pressable onPress={rebuildFromCenterAndSize} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}>
            <Text style={styles.secondaryButtonText}>Применить метраж</Text>
          </Pressable>
          <Pressable disabled={locating} onPress={() => void useGPS()} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}>
            {locating ? <ActivityIndicator size="small" color={colors.primary} /> : <Text style={styles.secondaryButtonText}>GPS</Text>}
          </Pressable>
        </View>

        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>КООРДИНАТЫ УГЛОВ</Text>
        </View>

        <Card style={styles.formCard}>
          {boundary.map((point, index) => (
            <View key={`corner-row-${index}`}>
              <View style={styles.cornerRow}>
                <Text style={styles.cornerLabel}>Угол {index + 1}</Text>
                <View style={styles.cornerInputs}>
                  <TextInput
                    value={formatCoord(point.latitude)}
                    onChangeText={(value) => updateCornerText(index, 'latitude', value)}
                    keyboardType="decimal-pad"
                    style={styles.cornerInput}
                  />
                  <TextInput
                    value={formatCoord(point.longitude)}
                    onChangeText={(value) => updateCornerText(index, 'longitude', value)}
                    keyboardType="decimal-pad"
                    style={styles.cornerInput}
                  />
                </View>
              </View>
              {index < boundary.length - 1 && <View style={styles.divider} />}
            </View>
          ))}
        </Card>

        <Pressable disabled={saving} onPress={() => void save()} style={({ pressed }) => [styles.primaryButton, (pressed || saving) && styles.pressed]}>
          {saving ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>{isEditing ? 'Сохранить изменения' : 'Сохранить участок'}</Text>}
        </Pressable>
      </Screen>
    </KeyboardAvoidingView>
  );
}

function FieldInput({ label, compact, ...props }: { label: string; compact?: boolean } & ComponentProps<typeof TextInput>) {
  return (
    <View style={[styles.inputGroup, compact && styles.inputCompact]}>
      <Text style={styles.inputLabel} numberOfLines={1}>{label}</Text>
      <TextInput {...props} placeholderTextColor={colors.muted} style={styles.input} />
    </View>
  );
}

function parseCenter(lat: string, lng: string): Coordinate | null {
  const latitude = Number(lat.replace(',', '.'));
  const longitude = Number(lng.replace(',', '.'));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function parseMeters(value: string): number | null {
  const parsed = Number(value.replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed < MIN_SIZE_M) return null;
  return parsed;
}

function buildRectangle(center: Coordinate, widthM: number, heightM: number): Coordinate[] {
  const latDelta = heightM / 2 / 111_320;
  const lngDelta = widthM / 2 / (111_320 * Math.cos((center.latitude * Math.PI) / 180));
  return [
    { latitude: center.latitude - latDelta, longitude: center.longitude - lngDelta },
    { latitude: center.latitude - latDelta, longitude: center.longitude + lngDelta },
    { latitude: center.latitude + latDelta, longitude: center.longitude + lngDelta },
    { latitude: center.latitude + latDelta, longitude: center.longitude - lngDelta },
  ];
}

function normalizeBoundary(points: Coordinate[]): Coordinate[] {
  if (points.length >= 4) return points.slice(0, 4);
  return buildRectangle(DEFAULT_CENTER, DEFAULT_WIDTH_M, DEFAULT_HEIGHT_M);
}

function getBounds(points: Coordinate[]) {
  const latitudes = points.map((point) => point.latitude);
  const longitudes = points.map((point) => point.longitude);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLng = Math.min(...longitudes);
  const maxLng = Math.max(...longitudes);
  return {
    center: { latitude: (minLat + maxLat) / 2, longitude: (minLng + maxLng) / 2 },
    latDelta: maxLat - minLat,
    lngDelta: maxLng - minLng,
  };
}

function regionFromBoundary(points: Coordinate[]): Region {
  const bounds = getBounds(points);
  return {
    latitude: bounds.center.latitude,
    longitude: bounds.center.longitude,
    latitudeDelta: Math.max(bounds.latDelta * 1.8, 0.006),
    longitudeDelta: Math.max(bounds.lngDelta * 1.8, 0.006),
  };
}

function estimateWidthHeight(points: Coordinate[]) {
  const bounds = getBounds(points);
  const widthM = bounds.lngDelta * 111_320 * Math.cos((bounds.center.latitude * Math.PI) / 180);
  const heightM = bounds.latDelta * 111_320;
  return { widthM: Math.max(widthM, MIN_SIZE_M), heightM: Math.max(heightM, MIN_SIZE_M) };
}

function computeAreaHa(points: Coordinate[]): number {
  if (points.length < 3) return 0;
  const meanLat = points.reduce((sum, point) => sum + point.latitude, 0) / points.length;
  const meanLng = points.reduce((sum, point) => sum + point.longitude, 0) / points.length;
  const latRad = (meanLat * Math.PI) / 180;
  const kLat = 111.32;
  const kLng = 111.32 * Math.cos(latRad);
  const xy = points.map((point) => ({ x: (point.longitude - meanLng) * kLng, y: (point.latitude - meanLat) * kLat }));
  let area = 0;
  for (let i = 0; i < xy.length; i += 1) {
    const next = (i + 1) % xy.length;
    area += xy[i].x * xy[next].y - xy[next].x * xy[i].y;
  }
  return Math.abs(area) * 50;
}

function computePerimeterKm(points: Coordinate[]): number {
  if (points.length < 2) return 0;
  let perimeter = 0;
  for (let i = 0; i < points.length; i += 1) {
    perimeter += distanceKm(points[i], points[(i + 1) % points.length]);
  }
  return perimeter;
}

function distanceKm(a: Coordinate, b: Coordinate): number {
  const earthRadiusKm = 6371;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(h));
}

function formatCoord(value: number) {
  return value.toFixed(6);
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  loadingText: { fontFamily: fontFamilies.medium, fontSize: 13, color: colors.textSecondary },
  content: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 36, gap: 12 },
  titleBlock: { gap: 4 },
  title: { fontFamily: fontFamilies.bold, fontSize: 20, color: colors.text },
  subtitle: { fontFamily: fontFamilies.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  formCard: { padding: 0 },
  inputGroup: { paddingHorizontal: 12, paddingVertical: 10, gap: 5 },
  inputCompact: { flex: 1, minWidth: 0 },
  inputLabel: { fontFamily: fontFamilies.semiBold, fontSize: 11, color: colors.textSecondary, textTransform: 'uppercase' },
  input: { minHeight: 38, padding: 0, fontFamily: fontFamilies.medium, fontSize: 14, color: colors.text },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  suggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    minHeight: 34,
    maxWidth: '48%',
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  chipActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  chipText: { fontFamily: fontFamilies.medium, fontSize: 12.5, color: colors.textSecondary },
  chipTextActive: { color: colors.primaryDark },
  modeSwitchWrap: {
    flexDirection: 'row',
    backgroundColor: '#E5E5EA',
    borderRadius: 10,
    padding: 2,
    gap: 2,
  },
  modeTab: {
    flex: 1,
    minHeight: 34,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeTabActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.12,
    shadowRadius: 2,
    elevation: 2,
  },
  modeTabText: { fontFamily: fontFamilies.medium, fontSize: 12.5, color: colors.textSecondary },
  modeTabTextActive: { fontFamily: fontFamilies.semiBold, color: colors.text },
  modeHint: { fontFamily: fontFamilies.regular, fontSize: 11.5, lineHeight: 15, color: colors.muted, paddingHorizontal: 2 },
  cornerMarker: { alignItems: 'center', justifyContent: 'center', padding: 6 },
  cornerMarkerInner: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.primary,
    borderWidth: 2,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.25,
    shadowRadius: 2,
    elevation: 3,
  },
  cornerMarkerInnerActive: {
    backgroundColor: colors.danger,
    width: 30,
    height: 30,
    borderRadius: 15,
  },
  cornerMarkerText: { fontFamily: fontFamilies.bold, fontSize: 12, color: '#FFFFFF' },
  mapFrame: {
    height: 300,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
  },
  map: { flex: 1 },
  mapFallback: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  mapFallbackText: { fontFamily: fontFamilies.regular, fontSize: 13, color: colors.textSecondary, textAlign: 'center' },
  mapInfo: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 8,
    minHeight: 34,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.94)',
    paddingHorizontal: 10,
    justifyContent: 'center',
  },
  mapInfoText: { fontFamily: fontFamilies.semiBold, fontSize: 12, color: colors.text, textAlign: 'center' },
  twoCols: { flexDirection: 'row' },
  actionsRow: { flexDirection: 'row', gap: 10 },
  secondaryButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  secondaryButtonText: { fontFamily: fontFamilies.semiBold, fontSize: 13, color: colors.primary, textAlign: 'center' },
  segmentButton: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  segmentButtonText: { fontFamily: fontFamilies.semiBold, fontSize: 13, color: colors.primaryDark, textAlign: 'center' },
  sectionHeaderRow: { paddingHorizontal: 4 },
  sectionTitle: { fontFamily: fontFamilies.semiBold, fontSize: 12, color: colors.textSecondary },
  cornerRow: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  cornerLabel: { fontFamily: fontFamilies.semiBold, fontSize: 12, color: colors.text },
  cornerInputs: { flexDirection: 'row', gap: 8 },
  cornerInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 40,
    borderRadius: 8,
    backgroundColor: colors.surfaceSecondary,
    paddingHorizontal: 8,
    fontFamily: fontFamilies.medium,
    fontSize: 12.5,
    color: colors.text,
  },
  primaryButton: { minHeight: 50, borderRadius: 10, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { fontFamily: fontFamilies.semiBold, fontSize: 15, color: '#FFFFFF' },
  pressed: { opacity: 0.72 },
});
