import { ComponentProps, ComponentRef, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { Text, TextInput } from '../../src/components/AppText';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Location from 'expo-location';
import MapView, { MapPressEvent, Marker, Polygon, Region } from '../../src/components/AppMapView';

import { Card } from '../../src/components/Card';
import { Screen } from '../../src/components/Screen';
import { createField, detectFieldBoundary, getField, updateField } from '../../src/services/api';
import { colors } from '../../src/theme/colors';
import { fontFamilies } from '../../src/theme/typography';
import { AutoBoundaryResult, Coordinate, Field } from '../../src/types/domain';
import { notify } from '../../src/utils/notify';

const DEFAULT_CENTER: Coordinate = { latitude: 53.283, longitude: 69.38 };
const DEFAULT_WIDTH_M = 800;
const DEFAULT_HEIGHT_M = 600;
const MIN_SIZE_M = 20;
const CROP_SUGGESTIONS = ['Яровая пшеница', 'Ячмень', 'Рапс', 'Подсолнечник', 'Картофель', 'Овёс'];

export default function NewFieldScreen() {
  const router = useRouter();
  const mapRef = useRef<ComponentRef<typeof MapView>>(null);
  const { profileId, fieldId } = useLocalSearchParams<{ profileId?: string; fieldId?: string }>();
  const isEditing = Boolean(fieldId);

  const [mapActive, setMapActive] = useState(false);
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
  const [editMode, setEditMode] = useState<'move' | 'corners' | 'auto'>('corners');
  const [activeCorner, setActiveCorner] = useState<number | null>(null);
  const [mapType, setMapType] = useState<'standard' | 'satellite'>('satellite');
  const [autoSeed, setAutoSeed] = useState<Coordinate>(DEFAULT_CENTER);
  const [autoResult, setAutoResult] = useState<AutoBoundaryResult | null>(null);
  const markerPressHandledRef = useRef(false);

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
        notify('Участок не загружен', error instanceof Error ? error.message : 'Повторите попытку.');
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
    setAutoSeed(bounds.center);
  }

  function rebuildFromCenterAndSize() {
    const parsedCenter = parseCenter(centerLat, centerLng);
    const width = parseMeters(widthMeters);
    const height = parseMeters(heightMeters);
    if (!parsedCenter || width === null || height === null) {
      notify('Проверьте значения', 'Введите центр, ширину и длину числами.');
      return;
    }
    const nextBoundary = buildRectangle(parsedCenter, width, height);
    setBoundary(nextBoundary);
    mapRef.current?.animateToRegion(regionFromBoundary(nextBoundary), 250);
  }

  function addCornerAtCoordinate(point: Coordinate) {
    if (boundary.length < 3) {
      const next = [...boundary, point];
      setBoundary(next);
      syncMetaFromBoundary(next);
      setActiveCorner(next.length - 1);
      return;
    }
    let bestIndex = 0;
    let minDistance = Infinity;
    for (let i = 0; i < boundary.length; i++) {
      const p1 = boundary[i];
      const p2 = boundary[(i + 1) % boundary.length];
      const dist = distanceToSegment(point, p1, p2);
      if (dist < minDistance) {
        minDistance = dist;
        bestIndex = i + 1;
      }
    }
    const next = [...boundary];
    next.splice(bestIndex, 0, point);
    setBoundary(next);
    syncMetaFromBoundary(next);
    setActiveCorner(bestIndex);
  }

  function addCornerAtMidpoint() {
    if (boundary.length < 2) return;
    let longestIdx = 0;
    let maxDistSq = -1;
    for (let i = 0; i < boundary.length; i++) {
      const p1 = boundary[i];
      const p2 = boundary[(i + 1) % boundary.length];
      const d = (p1.latitude - p2.latitude) ** 2 + (p1.longitude - p2.longitude) ** 2;
      if (d > maxDistSq) {
        maxDistSq = d;
        longestIdx = i;
      }
    }
    const p1 = boundary[longestIdx];
    const p2 = boundary[(longestIdx + 1) % boundary.length];
    const mid: Coordinate = {
      latitude: (p1.latitude + p2.latitude) / 2,
      longitude: (p1.longitude + p2.longitude) / 2,
    };
    const next = [...boundary];
    next.splice(longestIdx + 1, 0, mid);
    setBoundary(next);
    syncMetaFromBoundary(next);
    setActiveCorner(longestIdx + 1);
  }

  function removeCornerByIndex(index: number) {
    if (boundary.length <= 3) {
      notify('Минимум 3 угла', 'Контур поля не может содержать меньше трёх вершин.');
      return;
    }
    const next = boundary.filter((_, idx) => idx !== index);
    setBoundary(next);
    syncMetaFromBoundary(next);
    if (activeCorner === index) {
      setActiveCorner(null);
    } else if (activeCorner !== null && activeCorner > index) {
      setActiveCorner(activeCorner - 1);
    }
  }

  function removeActiveCorner() {
    if (activeCorner === null) return;
    removeCornerByIndex(activeCorner);
  }

  function handleMapPress(event: MapPressEvent) {
    if (markerPressHandledRef.current) return;

    if (editMode === 'auto') {
      const point = event.nativeEvent.coordinate;
      setAutoSeed(point);
      void autoBoundaryFromSatellite(point);
      return;
    }
    if (editMode === 'move') {
      const nextCenter = event.nativeEvent.coordinate;
      const oldBounds = getBounds(boundary);
      const deltaLat = nextCenter.latitude - oldBounds.center.latitude;
      const deltaLng = nextCenter.longitude - oldBounds.center.longitude;
      const next = boundary.map((pt) => ({
        latitude: pt.latitude + deltaLat,
        longitude: pt.longitude + deltaLng,
      }));
      setBoundary(next);
      syncMetaFromBoundary(next);
      setAutoSeed(nextCenter);
      return;
    }
    if (editMode === 'corners') {
      if (activeCorner !== null) {
        updateCorner(activeCorner, event.nativeEvent.coordinate);
        setActiveCorner(null);
      } else {
        addCornerAtCoordinate(event.nativeEvent.coordinate);
      }
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

  async function autoBoundaryFromSatellite(seedOverride?: Coordinate) {
    if (segmenting) return;
    const centerCandidate = seedOverride ?? autoSeed ?? parseCenter(centerLat, centerLng) ?? getBounds(boundary).center;
    const safeLat = Number.isFinite(centerCandidate?.latitude) ? centerCandidate.latitude : DEFAULT_CENTER.latitude;
    const safeLng = Number.isFinite(centerCandidate?.longitude) ? centerCandidate.longitude : DEFAULT_CENTER.longitude;
    const center: Coordinate = { latitude: safeLat, longitude: safeLng };

    const size = estimateWidthHeight(boundary);
    // Clamp radius safely between 300m and 2400m to prevent out-of-range or huge bounding boxes
    const rawRadius = Math.max(Math.max(size.widthM, size.heightM) * 1.15, 600);
    const safeRadius = Math.max(300, Math.min(Number.isFinite(rawRadius) ? rawRadius : 700, 2400));

    setAutoSeed(center);
    setAutoResult(null);
    setSegmenting(true);
    try {
      const result = await detectFieldBoundary({
        latitude: center.latitude,
        longitude: center.longitude,
        radiusMeters: Math.round(safeRadius),
      });
      const nextBoundary = normalizeBoundary(result.boundary);
      setBoundary(nextBoundary);
      setAutoResult(result);
      syncMetaFromBoundary(nextBoundary);
      setEditMode('corners');
      setActiveCorner(null);
      mapRef.current?.fitToCoordinates(nextBoundary, {
        edgePadding: { top: 44, right: 36, bottom: 64, left: 36 },
        animated: true,
      });
    } catch (error) {
      notify(
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
      if (Math.abs(numeric) <= 180) {
        syncMetaFromBoundary(next);
      }
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
        notify('Геопозиция не получена', 'Можно ввести координаты центра вручную.');
        return;
      }
      const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const nextCenter = { latitude: location.coords.latitude, longitude: location.coords.longitude };
      setCenterLat(formatCoord(nextCenter.latitude));
      setCenterLng(formatCoord(nextCenter.longitude));
      const nextBoundary = buildRectangle(nextCenter, parseMeters(widthMeters) ?? DEFAULT_WIDTH_M, parseMeters(heightMeters) ?? DEFAULT_HEIGHT_M);
      setBoundary(nextBoundary);
      setAutoSeed(nextCenter);
      setAutoResult(null);
      mapRef.current?.animateToRegion(regionFromBoundary(nextBoundary), 400);
    } catch {
      notify('Ошибка GPS', 'Не удалось получить координаты.');
    } finally {
      setLocating(false);
    }
  }

  async function save() {
    if (saving) return;
    if (name.trim().length < 2 || cropType.trim().length < 2) {
      notify('Заполните данные', 'Введите название участка и культуру.');
      return;
    }
    if (boundary.length < 3 || boundary.some((point) => !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude))) {
      notify('Проверьте контур', 'В контуре должны быть корректные координаты углов.');
      return;
    }
    if (!isEditing && !profileId) {
      notify('Профиль не выбран', 'Вернитесь и выберите профиль.');
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
      notify('Не сохранено', error instanceof Error ? error.message : 'Повторите попытку.');
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Screen contentStyle={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>Загрузка поля…</Text>
      </Screen>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen contentStyle={styles.content} scrollEnabled={!mapActive}>
        <View style={styles.titleBlock}>
          <Text style={styles.title}>{isEditing ? 'Редактировать поле' : 'Новое поле'}</Text>
          <Text style={styles.subtitle}>Контур пашни можно распознать по снимку или уточнить вручную.</Text>
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
          <Pressable
            onPress={() => {
              setEditMode('auto');
              setActiveCorner(null);
              setMapType('satellite');
            }}
            style={[styles.modeTab, editMode === 'auto' && styles.modeTabActive]}
          >
            <Text style={[styles.modeTabText, editMode === 'auto' && styles.modeTabTextActive]} numberOfLines={1}>
              Автоконтур
            </Text>
          </Pressable>
        </View>
        <Text style={styles.modeHint}>
          {editMode === 'move'
            ? 'Тап по карте перемещает всё поле целиком в новую точку.'
            : editMode === 'auto'
            ? 'Тапните внутри пашни. Спутник Sentinel-2 найдёт контур поля автоматически.'
            : activeCorner === null
            ? 'Тапните по номеру угла, чтобы выбрать его, или по карте, чтобы добавить вершину.'
            : `Угол ${activeCorner + 1} выбран: перетащите его или тапните на карте в новое место.`}
        </Text>

        <View style={styles.mapFrame}>
          {(
            <MapView
              ref={mapRef}
              style={styles.map}
              initialRegion={mapRegion}
              onPress={handleMapPress}
              onGestureActiveChange={setMapActive}
              mapType={mapType}
              showsUserLocation
              showsMyLocationButton={false}
            >
              <Polygon coordinates={boundary} fillColor="rgba(27, 94, 32, 0.16)" strokeColor={colors.primary} strokeWidth={2} />
              {boundary.map((point, index) => {
                const isActive = activeCorner === index;
                return (
                  <Marker
                    key={`corner-${index}`}
                    coordinate={point}
                    label={index + 1}
                    pinColor={isActive ? '#0E3A14' : colors.primary}
                    draggable={editMode === 'corners'}
                    hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
                    tracksViewChanges
                    anchor={{ x: 0.5, y: 0.5 }}
                    onPress={(event) => {
                      event.stopPropagation();
                      markerPressHandledRef.current = true;
                      setTimeout(() => {
                        markerPressHandledRef.current = false;
                      }, 400);
                      if (editMode === 'corners') {
                        setActiveCorner((curr) => (curr === index ? null : index));
                      }
                    }}
                    onDragStart={() => {
                      markerPressHandledRef.current = true;
                      setActiveCorner(index);
                    }}
                    onDragEnd={(event) => {
                      markerPressHandledRef.current = true;
                      setTimeout(() => {
                        markerPressHandledRef.current = false;
                      }, 400);
                      updateCorner(index, event.nativeEvent.coordinate);
                    }}
                  >
                    <View style={styles.cornerMarker}>
                      <View style={[styles.cornerMarkerInner, isActive && styles.cornerMarkerInnerActive]}>
                        <Text style={styles.cornerMarkerText}>{index + 1}</Text>
                      </View>
                    </View>
                  </Marker>
                );
              })}
              {editMode === 'auto' && (
                <Marker coordinate={autoSeed} anchor={{ x: 0.5, y: 0.5 }}>
                  <View style={styles.seedMarker}>
                    <View style={styles.seedMarkerCore} />
                  </View>
                </Marker>
              )}
            </MapView>
          )}

          {Platform.OS !== 'web' && (
            <Pressable
              onPress={() => setMapType((current) => (current === 'standard' ? 'satellite' : 'standard'))}
              style={({ pressed }) => [styles.mapTypeButton, pressed && styles.pressed]}
            >
              <Text style={styles.mapTypeButtonText}>{mapType === 'standard' ? 'Спутник' : 'Схема'}</Text>
            </Pressable>
          )}
          {segmenting && (
            <View style={styles.segmentOverlay} pointerEvents="none">
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.segmentOverlayText}>Анализируем снимок и границы поля…</Text>
            </View>
          )}
          <View style={styles.mapInfo}>
            <Text style={styles.mapInfoText} numberOfLines={2}>
              {estimatedHa.toFixed(2)} га • периметр {estimatedPerimeterKm.toFixed(2)} км
            </Text>
          </View>
        </View>

        {activeCorner !== null && (
          <View style={styles.selectedCornerBanner}>
            <View style={styles.selectedCornerInfo}>
              <View style={styles.selectedCornerBadge}>
                <Text style={styles.selectedCornerBadgeText}>{activeCorner + 1}</Text>
              </View>
              <View style={styles.selectedCornerTexts}>
                <Text style={styles.selectedCornerTitle}>Угол {activeCorner + 1} выбран</Text>
                <Text style={styles.selectedCornerSub}>Перетащите метку или тапните на карте</Text>
              </View>
            </View>
            <View style={styles.selectedCornerActions}>
              {boundary.length > 3 && (
                <Pressable onPress={removeActiveCorner} style={({ pressed }) => [styles.bannerDeleteBtn, pressed && styles.pressed]}>
                  <Text style={styles.bannerDeleteBtnText}>🗑 Удалить</Text>
                </Pressable>
              )}
              <Pressable onPress={() => setActiveCorner(null)} style={({ pressed }) => [styles.bannerCancelBtn, pressed && styles.pressed]}>
                <Text style={styles.bannerCancelBtnText}>✕ Снять</Text>
              </Pressable>
            </View>
          </View>
        )}

        <View style={styles.actionsRow}>
          {editMode === 'corners' && (
            <Pressable onPress={addCornerAtMidpoint} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}>
              <Text style={styles.secondaryButtonText}>+ Добавить точку</Text>
            </Pressable>
          )}
          {editMode === 'corners' && boundary.length > 3 && (
            <Pressable
              onPress={() => {
                if (activeCorner !== null) {
                  removeActiveCorner();
                } else {
                  removeCornerByIndex(boundary.length - 1);
                }
              }}
              style={({ pressed }) => [styles.dangerButton, pressed && styles.pressed]}
            >
              <Text style={styles.dangerButtonText}>
                {activeCorner !== null ? `Удалить угол ${activeCorner + 1}` : 'Удалить посл. угол'}
              </Text>
            </Pressable>
          )}
          <Pressable onPress={centerContour} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}>
            <Text style={styles.secondaryButtonText}>Центрировать</Text>
          </Pressable>
        </View>

        <Pressable
          disabled={segmenting}
          onPress={() => {
            if (editMode !== 'auto') {
              setEditMode('auto');
              setActiveCorner(null);
              setMapType('satellite');
            }
            void autoBoundaryFromSatellite();
          }}
          style={({ pressed }) => [styles.segmentButton, (pressed || segmenting) && styles.pressed]}
        >
          {segmenting ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={styles.segmentButtonText}>
              🛰 Распознать контур поля со спутника
            </Text>
          )}
        </Pressable>

        {autoResult && (
          <View style={[styles.autoStatus, autoResult.needsReview && styles.autoStatusReview]}>
            <View style={styles.autoStatusHeader}>
              <Text style={[styles.autoStatusTitle, autoResult.needsReview && styles.autoStatusTitleReview]}>
                {autoResult.needsReview ? 'Контур требует проверки' : 'Пашня распознана'}
              </Text>
              <Text style={[styles.autoStatusConfidence, autoResult.needsReview && styles.autoStatusConfidenceReview]}>
                индекс границы {Math.round(autoResult.qualityScore * 100)}/100
              </Text>
            </View>
            <Text style={styles.autoStatusText}>
              {autoResult.pointCount} вершин · ≈ {autoResult.estimatedAreaHa.toFixed(1)} га · индекс компактности {autoResult.compactness.toFixed(2)}
            </Text>
            <Text style={styles.autoStatusText}>NDVI в точке {autoResult.seedNdvi.toFixed(2)} · покрытие окна {autoResult.coveragePercent.toFixed(1)}%</Text>
            {autoResult.warning ? <Text style={styles.autoStatusWarning}>{autoResult.warning}</Text> : null}
            <Text style={styles.autoStatusSource}>Sentinel-2 · {autoResult.spatialResolutionMeters} м/пикс · окно {autoResult.analysisWindowDays} дней</Text>
          </View>
        )}

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
          <Text style={styles.sectionTitle}>КООРДИНАТЫ УГЛОВ ({boundary.length})</Text>
          <Pressable onPress={addCornerAtMidpoint} style={({ pressed }) => [styles.headerAddBtn, pressed && styles.pressed]}>
            <Text style={styles.headerAddBtnText}>+ Добавить угол</Text>
          </Pressable>
        </View>

        <Card style={styles.formCard}>
          {boundary.map((point, index) => {
            const isSelected = activeCorner === index;
            return (
              <View key={`corner-row-${index}`}>
                <View style={[styles.cornerRow, isSelected && styles.cornerRowActive]}>
                  <View style={styles.cornerRowTop}>
                    <Pressable
                      onPress={() => {
                        setActiveCorner(isSelected ? null : index);
                        mapRef.current?.animateToRegion(
                          {
                            latitude: point.latitude,
                            longitude: point.longitude,
                            latitudeDelta: 0.005,
                            longitudeDelta: 0.005,
                          },
                          250
                        );
                      }}
                      style={styles.cornerHeaderPressable}
                    >
                      <View style={[styles.cornerNumberBadge, isSelected && styles.cornerNumberBadgeActive]}>
                        <Text style={[styles.cornerNumberText, isSelected && styles.cornerNumberTextActive]}>
                          {index + 1}
                        </Text>
                      </View>
                      <Text style={[styles.cornerLabel, isSelected && styles.cornerLabelActive]}>
                        Угол {index + 1} {isSelected ? '(выбран на карте)' : ''}
                      </Text>
                    </Pressable>

                    <Pressable
                      disabled={boundary.length <= 3}
                      onPress={() => removeCornerByIndex(index)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={({ pressed }) => [
                        styles.cornerDeleteBtn,
                        boundary.length <= 3 && styles.cornerDeleteBtnDisabled,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={[styles.cornerDeleteBtnText, boundary.length <= 3 && styles.cornerDeleteBtnTextDisabled]}>
                        Удалить
                      </Text>
                    </Pressable>
                  </View>

                  <View style={styles.cornerInputs}>
                    <TextInput
                      value={formatCoord(point.latitude)}
                      onChangeText={(value) => updateCornerText(index, 'latitude', value)}
                      keyboardType="decimal-pad"
                      style={[styles.cornerInput, isSelected && styles.cornerInputActive]}
                      placeholder="Широта (lat)"
                      placeholderTextColor={colors.muted}
                    />
                    <TextInput
                      value={formatCoord(point.longitude)}
                      onChangeText={(value) => updateCornerText(index, 'longitude', value)}
                      keyboardType="decimal-pad"
                      style={[styles.cornerInput, isSelected && styles.cornerInputActive]}
                      placeholder="Долгота (lng)"
                      placeholderTextColor={colors.muted}
                    />
                  </View>
                </View>
                {index < boundary.length - 1 && <View style={styles.divider} />}
              </View>
            );
          })}
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
  const valid = points.filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
  if (valid.length >= 3) {
    const first = valid[0];
    const last = valid[valid.length - 1];
    const closesRing = first.latitude === last.latitude && first.longitude === last.longitude;
    return closesRing ? valid.slice(0, -1) : valid;
  }
  return buildRectangle(DEFAULT_CENTER, DEFAULT_WIDTH_M, DEFAULT_HEIGHT_M);
}

function getBounds(points: Coordinate[]) {
  const valid = points.filter(
    (point) => point && Number.isFinite(point.latitude) && Number.isFinite(point.longitude)
  );
  const pts = valid.length > 0 ? valid : [DEFAULT_CENTER];
  const latitudes = pts.map((point) => point.latitude);
  const longitudes = pts.map((point) => point.longitude);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLng = Math.min(...longitudes);
  const maxLng = Math.max(...longitudes);
  return {
    center: { latitude: (minLat + maxLat) / 2, longitude: (minLng + maxLng) / 2 },
    latDelta: Math.max(maxLat - minLat, 0.001),
    lngDelta: Math.max(maxLng - minLng, 0.001),
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

function distanceToSegment(p: Coordinate, a: Coordinate, b: Coordinate): number {
  const dx = b.longitude - a.longitude;
  const dy = b.latitude - a.latitude;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return Math.hypot(p.longitude - a.longitude, p.latitude - a.latitude);
  }
  const t = Math.max(0, Math.min(1, ((p.longitude - a.longitude) * dx + (p.latitude - a.latitude) * dy) / lengthSq));
  const projX = a.longitude + t * dx;
  const projY = a.latitude + t * dy;
  return Math.hypot(p.longitude - projX, p.latitude - projY);
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
    backgroundColor: '#F59E0B',
    borderColor: '#FEF3C7',
    borderWidth: 3,
    width: 32,
    height: 32,
    borderRadius: 16,
    shadowColor: '#F59E0B',
    shadowOpacity: 0.6,
    shadowRadius: 6,
    elevation: 6,
  },

  cornerMarkerText: { fontFamily: fontFamilies.bold, fontSize: 12, color: '#FFFFFF' },
  seedMarker: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 2,
    borderColor: '#FFFFFF',
    backgroundColor: 'rgba(217,119,6,0.28)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  seedMarkerCore: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.warning },
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
  mapTypeButton: {
    position: 'absolute',
    right: 8,
    top: 8,
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(28,28,30,0.78)',
    justifyContent: 'center',
  },
  mapTypeButtonText: { fontFamily: fontFamilies.semiBold, fontSize: 12, color: '#FFFFFF' },
  segmentOverlay: {
    position: 'absolute',
    left: 8,
    right: 8,
    top: 52,
    minHeight: 48,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.96)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
  },
  segmentOverlayText: { fontFamily: fontFamilies.semiBold, fontSize: 12, color: colors.text },
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
  dangerButton: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#FCA5A5',
    backgroundColor: '#FEF2F2',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  dangerButtonText: { fontFamily: fontFamilies.semiBold, fontSize: 12.5, color: '#DC2626', textAlign: 'center' },

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
  autoStatus: {
    borderRadius: 10,
    backgroundColor: colors.successSoft,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 3,
  },
  autoStatusReview: { backgroundColor: colors.warningSoft },
  autoStatusHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  autoStatusTitle: { fontFamily: fontFamilies.semiBold, fontSize: 13, color: colors.primaryDark },
  autoStatusTitleReview: { color: '#78350F' },
  autoStatusConfidence: { fontFamily: fontFamilies.bold, fontSize: 13, color: colors.primary },
  autoStatusConfidenceReview: { color: colors.warning },
  autoStatusText: { fontFamily: fontFamilies.medium, fontSize: 12, lineHeight: 17, color: colors.text },
  autoStatusWarning: { fontFamily: fontFamilies.medium, fontSize: 12, lineHeight: 17, color: '#78350F' },
  autoStatusSource: { fontFamily: fontFamilies.regular, fontSize: 11, lineHeight: 15, color: colors.textSecondary },
  sectionHeaderRow: {
    paddingHorizontal: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: { fontFamily: fontFamilies.semiBold, fontSize: 12, color: colors.textSecondary },
  headerAddBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: colors.primarySoft,
  },
  headerAddBtnText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 12,
    color: colors.primaryDark,
  },
  selectedCornerBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FEF3C7',
    borderWidth: 1,
    borderColor: '#FDE68A',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    gap: 8,
  },
  selectedCornerInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  selectedCornerBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#F59E0B',
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedCornerBadgeText: {
    fontFamily: fontFamilies.bold,
    fontSize: 12,
    color: '#FFFFFF',
  },
  selectedCornerTexts: {
    flex: 1,
  },
  selectedCornerTitle: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 12.5,
    color: '#92400E',
  },
  selectedCornerSub: {
    fontFamily: fontFamilies.regular,
    fontSize: 10.5,
    color: '#B45309',
  },
  selectedCornerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  bannerDeleteBtn: {
    minHeight: 32,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: '#FEE2E2',
    borderWidth: 1,
    borderColor: '#FCA5A5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerDeleteBtnText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 11.5,
    color: '#DC2626',
  },
  bannerCancelBtn: {
    minHeight: 32,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerCancelBtnText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 11.5,
    color: colors.textSecondary,
  },
  cornerRow: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  cornerRowActive: {
    backgroundColor: 'rgba(245, 158, 11, 0.08)',
  },
  cornerRowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cornerHeaderPressable: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  cornerNumberBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cornerNumberBadgeActive: {
    backgroundColor: '#F59E0B',
    borderColor: '#F59E0B',
  },
  cornerNumberText: {
    fontFamily: fontFamilies.bold,
    fontSize: 11,
    color: colors.textSecondary,
  },
  cornerNumberTextActive: {
    color: '#FFFFFF',
  },
  cornerLabel: { fontFamily: fontFamilies.semiBold, fontSize: 12, color: colors.text },
  cornerLabelActive: {
    color: '#92400E',
    fontFamily: fontFamilies.bold,
  },
  cornerDeleteBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: '#FEE2E2',
  },
  cornerDeleteBtnDisabled: {
    backgroundColor: colors.surfaceSecondary,
    opacity: 0.4,
  },
  cornerDeleteBtnText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 11.5,
    color: '#DC2626',
  },
  cornerDeleteBtnTextDisabled: {
    color: colors.muted,
  },
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
  cornerInputActive: {
    borderColor: '#F59E0B',
    borderWidth: 1,
    backgroundColor: '#FFFBEB',
  },
  primaryButton: { minHeight: 50, borderRadius: 10, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { fontFamily: fontFamilies.semiBold, fontSize: 15, color: '#FFFFFF' },
  pressed: { opacity: 0.72 },
});
