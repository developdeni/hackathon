import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Text } from '../../src/components/AppText';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import MapView, { Marker, Polygon } from 'react-native-maps';

import { Badge } from '../../src/components/Badge';
import { Card } from '../../src/components/Card';
import { EmptyState } from '../../src/components/EmptyState';
import { Screen } from '../../src/components/Screen';
import {
  buildAuthorizedDownloadUrl,
  deleteField,
  getField,
  getFieldClassification,
  getFieldSatellite,
  getFieldWeather,
  getFieldZones,
  listInspections,
  syncOfflineQueue,
  CACHE_KEYS,
} from '../../src/services/api';
import { getLocalCache, getMemoryCache, saveLocalCache } from '../../src/services/offline';
import { colors } from '../../src/theme/colors';
import { fontFamilies } from '../../src/theme/typography';
import {
  AgroWeather,
  Field,
  Inspection,
  LandUseClassification,
  RiskZone,
  SatelliteData,
  SatelliteObservation,
  ZonesData,
} from '../../src/types/domain';

type MapMode = 'zones' | 'satellite' | 'boundary';

const NDVI_LEGEND_COLORS = ['#BD0026', '#F03B20', '#FD8D3C', '#FED976', '#78C679', '#238443'];

// ---------------------------------------------------------------------------
// Small reusable components
// ---------------------------------------------------------------------------

function SectionLabel({ title, right }: { title: string; right?: string }) {
  return (
    <View style={sStyles.wrap}>
      <Text style={sStyles.title} numberOfLines={1}>{title}</Text>
      {right ? <Text style={sStyles.right} numberOfLines={1}>{right}</Text> : null}
    </View>
  );
}

const sStyles = StyleSheet.create({
  wrap: { paddingHorizontal: 2, gap: 1 },
  title: { fontFamily: fontFamilies.semiBold, fontSize: 11.5, letterSpacing: 0.6, color: colors.textSecondary },
  right: { fontFamily: fontFamilies.medium, fontSize: 11, color: colors.muted },
});

function MetricCell({ value, unit, label }: { value: string; unit: string; label: string }) {
  return (
    <View style={mStyles.cell}>
      <View style={mStyles.valueRow}>
        <Text style={mStyles.value}>{value}</Text>
        {unit ? <Text style={mStyles.unit}>{unit}</Text> : null}
      </View>
      <Text style={mStyles.label}>{label}</Text>
    </View>
  );
}

const mStyles = StyleSheet.create({
  cell: { flex: 1, alignItems: 'center', paddingVertical: 10 },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 2 },
  value: { fontFamily: fontFamilies.bold, fontSize: 18, color: colors.text },
  unit: { fontFamily: fontFamilies.medium, fontSize: 11, color: colors.textSecondary, marginBottom: 1 },
  label: { fontFamily: fontFamilies.medium, fontSize: 11, color: colors.muted, marginTop: 2 },
});

function InfoRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={iStyles.row}>
      <Text style={iStyles.label} numberOfLines={1}>{label}</Text>
      <Text style={[iStyles.value, valueColor ? { color: valueColor } : null]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

const iStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 9 },
  label: { fontFamily: fontFamilies.regular, fontSize: 13.5, color: colors.textSecondary, flex: 1 },
  value: { fontFamily: fontFamilies.semiBold, fontSize: 13.5, color: colors.text, flex: 1.2, textAlign: 'right' },
});

function WeatherCell({ value, label, wide }: { value: string; label: string; wide?: boolean }) {
  return (
    <View style={[wStyles.cell, wide && wStyles.wide]}>
      <Text style={wStyles.value} numberOfLines={1}>{value}</Text>
      <Text style={wStyles.label}>{label}</Text>
    </View>
  );
}

const wStyles = StyleSheet.create({
  cell: { width: '50%', paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center' },
  wide: { width: '100%' },
  value: { fontFamily: fontFamilies.bold, fontSize: 16, color: colors.text },
  label: { fontFamily: fontFamilies.medium, fontSize: 11, color: colors.muted, marginTop: 2 },
});

function SegTab({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[segStyles.tab, active && segStyles.tabActive]}
    >
      <Text style={[segStyles.text, active && segStyles.textActive]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

const segStyles = StyleSheet.create({
  tab: { flex: 1, paddingVertical: 7, alignItems: 'center', borderRadius: 8 },
  tabActive: { backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.12, shadowRadius: 2, elevation: 2 },
  text: { fontFamily: fontFamilies.medium, fontSize: 12.5, color: colors.textSecondary },
  textActive: { fontFamily: fontFamilies.semiBold, color: colors.text },
});

function ZonePill({ zone, active, onPress }: { zone: RiskZone; active: boolean; onPress: () => void }) {
  const isCritical = zone.severity === 'critical';
  return (
    <Pressable
      onPress={onPress}
      style={[zpStyles.pill, active && (isCritical ? zpStyles.pillCritical : zpStyles.pillModerate)]}
    >
      <View style={[zpStyles.dot, { backgroundColor: isCritical ? colors.danger : colors.warning }]} />
      <Text style={[zpStyles.text, active && zpStyles.textActive]} numberOfLines={1}>{zone.title}</Text>
    </Pressable>
  );
}

const zpStyles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pillCritical: { borderColor: colors.danger, backgroundColor: colors.dangerSoft },
  pillModerate: { borderColor: colors.warning, backgroundColor: colors.warningSoft },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  text: { fontFamily: fontFamilies.medium, fontSize: 12, color: colors.textSecondary, flex: 1 },
  textActive: { fontFamily: fontFamilies.semiBold, color: colors.text },
});

function ActionRow({ title, destructive, onPress }: { title: string; destructive?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [arStyles.row, pressed && arStyles.pressed]}
    >
      <Text style={[arStyles.text, destructive && arStyles.textDestructive]}>{title}</Text>
      <Text style={[arStyles.chevron, destructive && arStyles.chevronDestructive]}>›</Text>
    </Pressable>
  );
}

const arStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 13, gap: 8 },
  pressed: { backgroundColor: colors.surfaceSecondary },
  text: { flex: 1, fontFamily: fontFamilies.medium, fontSize: 14.5, color: colors.text },
  textDestructive: { color: colors.danger },
  chevron: { fontFamily: fontFamilies.regular, fontSize: 20, color: colors.muted },
  chevronDestructive: { color: '#F4B4B4' },
});

function IndexHistory({ observations }: { observations: SatelliteObservation[] }) {
  const recent = observations.slice(-6).reverse();
  return (
    <Card style={historyStyles.card}>
      <View style={historyStyles.legendRow}>
        <View style={historyStyles.legendItem}>
          <View style={[historyStyles.legendDot, { backgroundColor: colors.primary }]} />
          <Text style={historyStyles.legendText}>NDVI</Text>
        </View>
        <View style={historyStyles.legendItem}>
          <View style={[historyStyles.legendDot, { backgroundColor: colors.info }]} />
          <Text style={historyStyles.legendText}>NDMI</Text>
        </View>
        <Text style={historyStyles.legendNote}>последние {Math.min(observations.length, 18)}</Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={historyStyles.chartContent}>
        {observations.slice(-18).map((item, index) => {
          const ndviHeight = Math.max(4, Math.min(76, ((item.ndviMean + 0.35) / 1.35) * 76));
          const ndmiHeight = item.ndmiMean == null ? 0 : Math.max(4, Math.min(76, ((item.ndmiMean + 0.55) / 1.35) * 76));
          return (
            <View key={`${item.date}-${index}`} style={historyStyles.chartColumn}>
              <View style={historyStyles.barArea}>
                <View style={[historyStyles.bar, { height: ndviHeight, backgroundColor: colors.primary }]} />
                {item.ndmiMean != null && <View style={[historyStyles.bar, { height: ndmiHeight, backgroundColor: colors.info }]} />}
              </View>
              <Text style={historyStyles.dateLabel}>{item.date.slice(5).replace('-', '.')}</Text>
            </View>
          );
        })}
      </ScrollView>

      <View style={historyStyles.tableHeader}>
        <Text style={[historyStyles.headerCell, historyStyles.dateCell]}>Дата</Text>
        <Text style={historyStyles.headerCell}>NDVI</Text>
        <Text style={historyStyles.headerCell}>NDMI</Text>
        <Text style={historyStyles.headerCell}>Облака</Text>
      </View>
      {recent.map((item, index) => (
        <View key={`row-${item.date}-${index}`} style={[historyStyles.tableRow, index > 0 && historyStyles.tableDivider]}>
          <Text style={[historyStyles.valueCell, historyStyles.dateCell]}>{item.date}</Text>
          <Text style={historyStyles.valueCell}>{item.ndviMean.toFixed(2)}</Text>
          <Text style={historyStyles.valueCell}>{item.ndmiMean == null ? '—' : item.ndmiMean.toFixed(2)}</Text>
          <Text style={historyStyles.valueCell}>{item.cloudCoveragePercent.toFixed(0)}%</Text>
        </View>
      ))}
    </Card>
  );
}

const historyStyles = StyleSheet.create({
  card: { padding: 0, overflow: 'hidden' },
  legendRow: { minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontFamily: fontFamilies.semiBold, fontSize: 12, color: colors.text },
  legendNote: { marginLeft: 'auto', fontFamily: fontFamilies.regular, fontSize: 11, color: colors.textSecondary },
  chartContent: { minHeight: 116, paddingHorizontal: 12, paddingBottom: 8, gap: 7 },
  chartColumn: { width: 29, alignItems: 'center', justifyContent: 'flex-end', gap: 5 },
  barArea: { height: 80, flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  bar: { width: 8, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  dateLabel: { fontFamily: fontFamilies.medium, fontSize: 9.5, color: colors.muted },
  tableHeader: { flexDirection: 'row', backgroundColor: colors.surfaceSecondary, paddingHorizontal: 14, paddingVertical: 7 },
  tableRow: { flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 8 },
  tableDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  headerCell: { flex: 1, textAlign: 'right', fontFamily: fontFamilies.semiBold, fontSize: 10.5, color: colors.textSecondary },
  valueCell: { flex: 1, textAlign: 'right', fontFamily: fontFamilies.medium, fontSize: 11.5, color: colors.text },
  dateCell: { flex: 1.45, textAlign: 'left' },
});

// ---------------------------------------------------------------------------
// Main Screen
// ---------------------------------------------------------------------------

export default function FieldScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  // Instant hydration from fast memory cache (0ms perceived latency)
  const initialField = id ? getMemoryCache<Field>(CACHE_KEYS.FIELD(id)) : null;
  const initialInspections = id ? getMemoryCache<Inspection[]>(CACHE_KEYS.INSPECTIONS(id)) ?? [] : [];
  const initialSat = id ? getMemoryCache<SatelliteData>(CACHE_KEYS.SATELLITE(id)) : null;
  const initialZones = id ? getMemoryCache<ZonesData>(CACHE_KEYS.ZONES(id)) : null;
  const initialWeather = id ? getMemoryCache<AgroWeather>(CACHE_KEYS.WEATHER(id)) : null;
  const initialClass = id ? getMemoryCache<LandUseClassification>(CACHE_KEYS.CLASSIFICATION(id)) : null;

  const [field, setField] = useState<Field | null>(initialField);
  const [inspections, setInspections] = useState<Inspection[]>(initialInspections);
  const [satellite, setSatellite] = useState<SatelliteData | null>(initialSat);
  const [zonesData, setZonesData] = useState<ZonesData | null>(initialZones);
  const [weather, setWeather] = useState<AgroWeather | null>(initialWeather);
  const [classification, setClassification] = useState<LandUseClassification | null>(initialClass);
  const [mapMode, setMapMode] = useState<MapMode>('zones');
  const [mapType, setMapType] = useState<'standard' | 'satellite'>('standard');
  const [selectedZone, setSelectedZone] = useState<RiskZone | null>(initialZones?.zones?.[0] ?? null);
  const [loading, setLoading] = useState(!initialField);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;

    // 1. If memory was empty on cold start, try disk cache immediately
    if (!field) {
      const cachedField = await getLocalCache<Field>(CACHE_KEYS.FIELD(id));
      if (cachedField) {
        setField(cachedField);
        const [cachedInsp, cachedSat, cachedZones, cachedW, cachedCl] = await Promise.all([
          getLocalCache<Inspection[]>(CACHE_KEYS.INSPECTIONS(id)),
          getLocalCache<SatelliteData>(CACHE_KEYS.SATELLITE(id)),
          getLocalCache<ZonesData>(CACHE_KEYS.ZONES(id)),
          getLocalCache<AgroWeather>(CACHE_KEYS.WEATHER(id)),
          getLocalCache<LandUseClassification>(CACHE_KEYS.CLASSIFICATION(id)),
        ]);
        if (cachedInsp) setInspections(cachedInsp);
        if (cachedSat) setSatellite(cachedSat);
        if (cachedZones) {
          setZonesData(cachedZones);
          if (cachedZones.zones.length > 0) setSelectedZone(cachedZones.zones[0]);
        }
        if (cachedW) setWeather(cachedW);
        if (cachedCl) setClassification(cachedCl);
        setLoading(false);
      } else {
        setLoading(true);
      }
    }

    setError(null);
    try {
      void syncOfflineQueue().catch(() => {});

      const [fieldRes, inspectionsRes, satRes, zonesRes, weatherRes, classificationRes] = await Promise.allSettled([
        getField(id),
        listInspections(id),
        getFieldSatellite(id),
        getFieldZones(id),
        getFieldWeather(id),
        getFieldClassification(id),
      ]);

      if (fieldRes.status === 'fulfilled') {
        setField(fieldRes.value);
      } else if (!field) {
        throw new Error(fieldRes.reason instanceof Error ? fieldRes.reason.message : 'Не удалось загрузить поле');
      }
      if (inspectionsRes.status === 'fulfilled') setInspections(inspectionsRes.value);
      if (satRes.status === 'fulfilled') setSatellite(satRes.value);
      if (zonesRes.status === 'fulfilled') {
        setZonesData(zonesRes.value);
        if (zonesRes.value.zones.length > 0 && !selectedZone) setSelectedZone(zonesRes.value.zones[0]);
      }
      if (weatherRes.status === 'fulfilled') setWeather(weatherRes.value);
      if (classificationRes.status === 'fulfilled') setClassification(classificationRes.value);
    } catch (nextError) {
      if (!field) {
        setError(nextError instanceof Error ? nextError.message : 'Ошибка загрузки');
      }
    } finally {
      setLoading(false);
    }
  }, [id, field, selectedZone]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const region = useMemo(() => {
    if (!field) return undefined;
    const lats = field.boundary.map((p) => p.latitude);
    const lngs = field.boundary.map((p) => p.longitude);
    const minLat = Math.min(...lats); const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs); const maxLng = Math.max(...lngs);
    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLng + maxLng) / 2,
      latitudeDelta: Math.max((maxLat - minLat) * 1.7, 0.014),
      longitudeDelta: Math.max((maxLng - minLng) * 1.7, 0.014),
    };
  }, [field]);

  // --- Loading / Error states ---
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={styles.loadingText}>Загрузка данных поля…</Text>
      </View>
    );
  }
  if (error || !field || !region) {
    return (
      <View style={styles.center}>
        <Text style={styles.errTitle}>Ошибка загрузки</Text>
        <Text style={styles.errText}>{error ?? 'Поле не найдено'}</Text>
        <Pressable onPress={load} style={styles.retryBtn}>
          <Text style={styles.retryText}>Повторить</Text>
        </Pressable>
      </View>
    );
  }

  const latestObs = satellite?.observations?.[satellite.observations.length - 1];
  const avatar = getCropAvatar(field.cropType);

  function confirmDelete() {
    Alert.alert(
      'Удалить участок?',
      `«${field!.name}» и все его осмотры будут удалены из локальной базы.`,
      [
        { text: 'Отмена', style: 'cancel' },
        { text: 'Удалить', style: 'destructive', onPress: () => void removeField() },
      ],
    );
  }

  async function removeField() {
    try {
      await deleteField(field!.id);
      router.replace({ pathname: '/', params: { profileId: field!.profileId } });
    } catch (e) {
      Alert.alert('Не удалось удалить', e instanceof Error ? e.message : 'Повторите попытку.');
    }
  }

  async function openExport(format: 'geojson' | 'csv' | 'pdf') {
    try {
      const url = await buildAuthorizedDownloadUrl(`/api/fields/${encodeURIComponent(field!.id)}/export/${format}`);
      const canOpen = await Linking.canOpenURL(url);
      if (!canOpen) {
        Alert.alert('Выгрузка недоступна', 'Устройство не может открыть этот тип файла.');
        return;
      }
      await Linking.openURL(url);
    } catch (e) {
      Alert.alert('Не удалось открыть отчёт', e instanceof Error ? e.message : 'Повторите попытку.');
    }
  }

  const ndviStatusColor = zonesData?.meanFieldNdvi != null
    ? (zonesData.meanFieldNdvi > 0.5 ? colors.success : colors.warning)
    : colors.text;

  return (
    <Screen contentStyle={styles.content}>

      {/* ── 1. OVERVIEW CARD ───────────────────────────────────── */}
      <Card style={styles.overviewCard}>
        <View style={styles.overviewHeader}>
          <View style={[styles.cropAvatar, { backgroundColor: avatar.bg }]}>
            <Text style={[styles.cropAvatarText, { color: avatar.text }]}>{avatar.short}</Text>
          </View>
          <View style={styles.overviewTitles}>
            <Text style={styles.fieldName} numberOfLines={2}>{field.name}</Text>
            <Text style={styles.fieldCrop} numberOfLines={1}>{field.cropType}</Text>
          </View>
          {field.isDemo && <Badge label="Демо" variant="muted" style={{ flexShrink: 0 }} />}
        </View>

        <View style={styles.hairline} />

        <View style={styles.metricsRow}>
          <MetricCell value={field.areaHa.toFixed(1)} unit="га" label="Площадь" />
          <View style={styles.vertDiv} />
          <MetricCell
            value={field.perimeterKm != null ? field.perimeterKm.toFixed(1) : '—'}
            unit="км"
            label="Периметр"
          />
          <View style={styles.vertDiv} />
          <MetricCell value={String(inspections.length)} unit="" label="Осмотров" />
        </View>
      </Card>

      {classification && (
        <>
          <SectionLabel title="ИСПОЛЬЗОВАНИЕ ЗЕМЛИ" right="NDVI амплитуда" />
          <Card style={styles.classCard}>
            <View style={styles.classHeader}>
              <Badge
                label={classification.label}
                variant={classification.status === 'active' ? 'success' : classification.status === 'fallow' ? 'warning' : 'neutral'}
              />
              <Text style={styles.classRule} numberOfLines={1}>
                {classification.amplitude != null ? `Δ ${classification.amplitude.toFixed(2)}` : 'мало снимков'}
              </Text>
            </View>
            <Text style={styles.classDescription}>{classification.description}</Text>
            <View style={styles.hairline} />
            <View style={styles.classMetrics}>
              <MetricCell value={classification.minNdvi != null ? classification.minNdvi.toFixed(2) : '—'} unit="" label="min NDVI" />
              <View style={styles.vertDiv} />
              <MetricCell value={classification.maxNdvi != null ? classification.maxNdvi.toFixed(2) : '—'} unit="" label="max NDVI" />
            </View>
          </Card>
        </>
      )}

      {/* ── 2. SATELLITE STATUS ────────────────────────────────── */}
      <SectionLabel
        title="СПУТНИКОВЫЙ АНАЛИЗ"
        right={satellite?.status === 'ready' ? 'Sentinel Hub · live' : undefined}
      />
      <Card style={styles.satCard}>
        <View style={styles.satMissionRow}>
          <Text style={styles.satMission} numberOfLines={1}>Sentinel-2 L2A · 10 м/пикс</Text>
          <Badge
            label={satellite?.status === 'ready' ? 'Готово' : 'Ожидание'}
            variant={satellite?.status === 'ready' ? 'success' : 'neutral'}
          />
        </View>

        <View style={styles.hairline} />

        {satellite?.status === 'ready' && latestObs ? (
          <>
            <View style={styles.satStatsRow}>
              <View style={styles.satStatCell}>
                <Text style={[styles.satStatVal, { color: ndviStatusColor }]}>{latestObs.ndviMean.toFixed(2)}</Text>
                <Text style={styles.satStatLabel}>NDVI поля</Text>
              </View>
              <View style={styles.vertDiv} />
              <View style={styles.satStatCell}>
                <Text style={styles.satStatVal}>{latestObs.ndmiMean != null ? latestObs.ndmiMean.toFixed(2) : '—'}</Text>
                <Text style={styles.satStatLabel}>NDMI поля</Text>
              </View>
              <View style={styles.vertDiv} />
              <View style={styles.satStatCell}>
                <Text style={styles.satStatVal}>{latestObs.cloudCoveragePercent.toFixed(0)}%</Text>
                <Text style={styles.satStatLabel}>Облачность</Text>
              </View>
            </View>
            <View style={styles.hairline} />
            <View style={styles.satObsRow}>
              <Text style={styles.satObsText} numberOfLines={1}>Снимок от {latestObs.date}</Text>
            </View>
            {latestObs.anomalyDetected && latestObs.anomalyFactor && (
              <View style={styles.anomalyBox}>
                <Text style={styles.anomalyText}>{latestObs.anomalyFactor}</Text>
              </View>
            )}
          </>
        ) : (
          <View style={styles.pendingBox}>
            <Text style={styles.pendingText}>
              {satellite?.message ?? 'Обработанный снимок Sentinel-2 для этого поля пока недоступен.'}
            </Text>
          </View>
        )}
      </Card>

      {satellite?.status === 'ready' && satellite.observations.length > 0 && (
        <>
          <SectionLabel
            title="СЕЗОННАЯ ДИНАМИКА"
            right={`${satellite.observationCount ?? satellite.observations.length} наблюдений`}
          />
          <IndexHistory observations={satellite.observations} />
          <Card style={styles.dataSourceCard}>
            <InfoRow
              label="Период анализа"
              value={`${satellite.periodStart ?? satellite.observations[0].date} — ${satellite.periodEnd ?? latestObs?.date}`}
            />
            <View style={styles.hairline} />
            <InfoRow label="Пространственное разрешение" value={`${satellite.spatialResolutionMeters} м/пикс`} />
            <View style={styles.hairline} />
            <InfoRow label="Маска облаков" value={satellite.cloudMaskingMethod} />
          </Card>
        </>
      )}

      {/* ── 3. WEATHER ─────────────────────────────────────────── */}
      {weather && (
        <>
          <SectionLabel title="АГРОМЕТЕОРОЛОГИЯ" right="Open-Meteo · актуально" />
          <Card style={styles.weatherCard}>
            <View style={styles.weatherGrid}>
              <WeatherCell value={`${weather.current.temperature.toFixed(1)}°C`} label="Температура" />
              <WeatherCell value={`${weather.current.humidity}%`} label="Влажность" />
              <WeatherCell value={`${weather.current.windSpeed.toFixed(1)} м/с`} label="Ветер сейчас" />
              <WeatherCell value={`${weather.forecast7d.precipSum.toFixed(1)} мм`} label="Осадки за 7 дней" />
            </View>

            {weather.forecast7d.evapotranspiration > 0 && (
              <>
                <View style={styles.hairline} />
                <View style={styles.etRow}>
                  <Text style={styles.etLabel} numberOfLines={1}>Испаряемость за 7 дней (ET₀)</Text>
                  <Text style={styles.etValue}>{weather.forecast7d.evapotranspiration.toFixed(1)} мм</Text>
                </View>
              </>
            )}

            {weather.forecast7d.gddSum != null && (
              <>
                <View style={styles.hairline} />
                <View style={styles.etRow}>
                  <Text style={styles.etLabel} numberOfLines={1}>Сумма эфф. температур (GDD, база 5°C)</Text>
                  <Text style={styles.etValue}>{weather.forecast7d.gddSum.toFixed(0)}°</Text>
                </View>
              </>
            )}

            {weather.alerts.length > 0 && (
              <View style={styles.alertBox}>
                <Text style={styles.alertTitle}>{weather.alerts[0].title}</Text>
                <Text style={styles.alertDesc}>{weather.alerts[0].description}</Text>
              </View>
            )}
          </Card>
        </>
      )}

      {/* ── 4. MAP ─────────────────────────────────────────────── */}
      <SectionLabel title="КАРТА УЧАСТКА" />
      <View style={styles.segmentedWrap}>
        <SegTab label="Зоны риска" active={mapMode === 'zones'} onPress={() => setMapMode('zones')} />
        <SegTab label="NDVI-снимок" active={mapMode === 'satellite'} onPress={() => setMapMode('satellite')} />
        <SegTab label="Контур" active={mapMode === 'boundary'} onPress={() => setMapMode('boundary')} />
      </View>

      <View style={styles.mapFrame}>
        {Platform.OS === 'web' ? (
          <View style={styles.mapFallback}>
            <Text style={styles.mapFallbackText}>Карта доступна на iOS / Android</Text>
          </View>
        ) : (
          <MapView style={styles.map} initialRegion={region} mapType={mapType}>
            <Polygon
              coordinates={field.boundary}
              fillColor={mapMode === 'boundary' ? 'rgba(30,126,52,0.10)' : 'rgba(30,126,52,0.04)'}
              strokeColor={colors.primary}
              strokeWidth={2}
            />
            {/* Реальная NDVI-тепловая карта поля из посотовой выборки Sentinel-2 */}
            {mapMode === 'satellite' && zonesData?.ndviGrid.map((cell) => (
              <Polygon
                key={cell.id}
                coordinates={cell.boundary}
                fillColor={cell.color}
                strokeColor="rgba(255,255,255,0.35)"
                strokeWidth={0.5}
              />
            ))}
            {mapMode === 'zones' && zonesData?.zones.map((zone) => (
              <Polygon
                key={zone.id}
                coordinates={zone.boundary}
                fillColor={zone.fillColor}
                strokeColor={selectedZone?.id === zone.id ? '#1C1C1E' : zone.strokeColor}
                strokeWidth={selectedZone?.id === zone.id ? 3 : 2}
                tappable
                onPress={() => setSelectedZone(zone)}
              />
            ))}
            {mapMode === 'zones' && selectedZone && (
              <Marker coordinate={selectedZone.centroid} title={selectedZone.title} description={`${selectedZone.areaHa.toFixed(1)} га`} />
            )}
          </MapView>
        )}

        <View style={styles.mapTag}>
          <Text style={styles.mapTagText} numberOfLines={1}>
            {mapMode === 'zones'
              ? 'Sentinel-2 · кластеры аномалий'
              : mapMode === 'satellite'
              ? (zonesData?.ndviGrid.length ? `NDVI-снимок · ${zonesData.ndviGrid.length} ячеек` : 'Ожидание снимка Sentinel-2')
              : 'Кадастровый контур участка'}
          </Text>
        </View>

        {mapMode === 'satellite' && zonesData?.ndviRange && zonesData.ndviGrid.length > 0 && (
          <View style={styles.ndviLegend}>
            <Text style={styles.ndviLegendVal}>{zonesData.ndviRange.min.toFixed(2)}</Text>
            <View style={styles.ndviLegendBar}>
              {NDVI_LEGEND_COLORS.map((c, i) => (
                <View key={i} style={[styles.ndviLegendSeg, { backgroundColor: c }]} />
              ))}
            </View>
            <Text style={styles.ndviLegendVal}>{zonesData.ndviRange.max.toFixed(2)}</Text>
          </View>
        )}

        {Platform.OS !== 'web' && (
          <Pressable
            onPress={() => setMapType((current) => (current === 'standard' ? 'satellite' : 'standard'))}
            style={styles.mapTypeToggle}
          >
            <Text style={styles.mapTypeToggleText}>{mapType === 'standard' ? 'Спутник' : 'Схема'}</Text>
          </Pressable>
        )}
      </View>

      {/* ── 5. RISK ZONES ──────────────────────────────────────── */}
      {zonesData && zonesData.zones.length > 0 ? (
        <>
          <SectionLabel
            title={`ОЧАГИ РИСКА — ${zonesData.zonesCount}`}
            right={`${zonesData.totalSuspectAreaHa.toFixed(1)} га / ${zonesData.totalFieldAreaHa.toFixed(0)} га`}
          />

          <View style={styles.zonePicker}>
            {zonesData.zones.map((zone) => (
              <ZonePill
                key={zone.id}
                zone={zone}
                active={selectedZone?.id === zone.id}
                onPress={() => setSelectedZone(zone)}
              />
            ))}
          </View>

          {selectedZone && (
            <Card style={styles.zoneCard}>
              {/* Zone metric row */}
              <View style={styles.zoneMetrics}>
                <View style={styles.zoneMetricCell}>
                  <Text style={[styles.zoneMetricVal, { color: selectedZone.severity === 'critical' ? colors.danger : colors.warning }]}>
                    {selectedZone.areaHa.toFixed(1)} га
                  </Text>
                  <Text style={styles.zoneMetricLabel}>{selectedZone.percentOfField.toFixed(1)}% поля</Text>
                </View>
                <View style={styles.vertDiv} />
                <View style={styles.zoneMetricCell}>
                  <Text style={styles.zoneMetricVal}>{selectedZone.ndviDeficit.toFixed(2)}</Text>
                  <Text style={styles.zoneMetricLabel}>Δ NDVI</Text>
                </View>
                <View style={styles.vertDiv} />
                <View style={styles.zoneMetricCell}>
                  <Text style={styles.zoneMetricVal}>{selectedZone.ndmiDeficit.toFixed(2)}</Text>
                  <Text style={styles.zoneMetricLabel}>Δ NDMI влага</Text>
                </View>
              </View>

              <View style={styles.hairline} />

              {/* Factor & Recommendation */}
              <View style={styles.zoneInfoBlock}>
                <Text style={styles.zoneInfoTitle}>Основной фактор</Text>
                <Text style={styles.zoneInfoText}>{selectedZone.mainFactor}</Text>
              </View>

              <View style={styles.hairline} />

              <View style={styles.zoneInfoBlock}>
                <Text style={styles.zoneInfoTitle}>Рекомендация</Text>
                <Text style={styles.zoneInfoText}>{selectedZone.recommendation}</Text>
              </View>

              <View style={styles.hairline} />

              <View style={styles.zonePersistenceRow}>
                <Text style={styles.zonePersistenceText}>{selectedZone.persistenceStatus}</Text>
              </View>

              {/* Dispatch button */}
              <Pressable
                onPress={() =>
                  router.push({
                    pathname: '/field/[id]/new-inspection',
                    params: {
                      id: field.id,
                      targetLat: String(selectedZone.centroid.latitude),
                      targetLng: String(selectedZone.centroid.longitude),
                      zoneTitle: `${selectedZone.title} (${selectedZone.areaHa.toFixed(1)} га)`,
                    },
                  })
                }
                style={({ pressed }) => [styles.dispatchBtn, pressed && styles.pressed]}
              >
                <Text style={styles.dispatchBtnText}>Выехать на осмотр этого очага →</Text>
              </Pressable>
            </Card>
          )}

          {/* Scouting savings */}
          {zonesData.benchmark && (
            <Card style={styles.savingsCard}>
              <InfoRow
                label="Целевой скаутинг"
                value={`${zonesData.benchmark.economicScouting.targetInspectionHa.toFixed(1)} га из ${zonesData.benchmark.economicScouting.fieldAreaHa.toFixed(0)} га`}
              />
              <View style={styles.hairline} />
              <InfoRow
                label="Экономия выездов"
                value={`~${(zonesData.benchmark.economicScouting.estimatedSeasonSavingsKzt / 1000).toFixed(0)} тыс ₸/сезон`}
                valueColor={colors.success}
              />
              <View style={styles.hairline} />
              <InfoRow
                label="Источник данных"
                value={zonesData.dataSource ?? zonesData.satelliteMission}
              />
            </Card>
          )}
        </>
      ) : (
        <>
          <SectionLabel title="ОЧАГИ РИСКА" />
          <Card style={styles.pendingZonesCard}>
            <Text style={styles.pendingZonesTitle}>Геометрия очагов недоступна</Text>
            <Text style={styles.pendingText}>
              {zonesData?.message ?? 'Требуется попиксельная обработка снимка Sentinel-2.'}
            </Text>
          </Card>
        </>
      )}

      {/* ── 6. ACTIONS ─────────────────────────────────────────── */}
      <SectionLabel title="ДЕЙСТВИЯ" />
      <Card style={styles.actionsCard}>
        <ActionRow
          title="+ Произвольный осмотр поля"
          onPress={() => router.push({ pathname: '/field/[id]/new-inspection', params: { id: field.id } })}
        />
        <View style={styles.hairline} />
        <ActionRow
          title="Редактировать контур и метраж"
          onPress={() => router.push({ pathname: '/field/new', params: { fieldId: field.id, profileId: field.profileId } })}
        />
        <View style={styles.hairline} />
        <ActionRow title="Скачать GeoJSON для QGIS" onPress={() => void openExport('geojson')} />
        <View style={styles.hairline} />
        <ActionRow title="Скачать CSV временного ряда" onPress={() => void openExport('csv')} />
        <View style={styles.hairline} />
        <ActionRow title="Скачать PDF-отчёт агронома" onPress={() => void openExport('pdf')} />
        <View style={styles.hairline} />
        <ActionRow title="Удалить участок" destructive onPress={confirmDelete} />
      </Card>

      {/* ── 7. INSPECTIONS ─────────────────────────────────────── */}
      <SectionLabel title={`ЖУРНАЛ ОСМОТРОВ (${inspections.length})`} />

      {inspections.length === 0 ? (
        <EmptyState
          title="Осмотры отсутствуют"
          text="Нажмите «Выехать на осмотр» выше или используйте произвольный осмотр."
        />
      ) : (
        <Card style={styles.inspGroup}>
          {inspections.map((insp, idx) => (
            <View key={insp.id}>
              <Pressable
                onPress={() => {
                  void saveLocalCache(CACHE_KEYS.INSPECTION(insp.id), insp);
                  router.push({ pathname: '/inspection/[id]', params: { id: insp.id } });
                }}
                style={({ pressed }) => [styles.inspRow, pressed && styles.inspRowPressed]}
              >
                {insp.photoUrl ? (
                  <Image source={{ uri: insp.photoUrl }} style={styles.thumb} />
                ) : (
                  <View style={styles.thumbPlaceholder}>
                    <Text style={styles.thumbPlaceholderText}>АКТ</Text>
                  </View>
                )}
                <View style={styles.inspMain}>
                  <View style={styles.inspTopRow}>
                    <Text style={styles.inspDate}>{formatDate(insp.createdAt)}</Text>
                    {insp.status === 'pending' ? (
                      <Badge label="Офлайн-очередь" variant="warning" />
                    ) : (
                      <Badge label="Сохранено" variant="success" />
                    )}
                  </View>
                  <Text numberOfLines={2} style={styles.inspNote}>
                    {insp.note || 'Без текстового описания'}
                  </Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
              {idx < inspections.length - 1 && <View style={styles.inspDivider} />}
            </View>
          ))}
        </Card>
      )}
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCropAvatar(cropType: string) {
  const t = cropType.toLowerCase();
  if (t.includes('пшениц')) return { short: 'ПШ', bg: colors.cropWheatBg, text: colors.cropWheatText };
  if (t.includes('рапс')) return { short: 'РП', bg: colors.cropRapeseedBg, text: colors.cropRapeseedText };
  return { short: 'КР', bg: colors.cropPotatoBg, text: colors.cropPotatoText };
}

function formatDate(iso: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  // Layout
  content: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 36,
    gap: 10,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    padding: 24,
    gap: 8,
  },
  loadingText: { fontFamily: fontFamilies.medium, fontSize: 13, color: colors.textSecondary },
  errTitle: { fontFamily: fontFamilies.semiBold, fontSize: 15, color: colors.danger },
  errText: { fontFamily: fontFamilies.regular, fontSize: 13, color: colors.textSecondary, textAlign: 'center' },
  retryBtn: { backgroundColor: colors.primary, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, marginTop: 6 },
  retryText: { fontFamily: fontFamilies.semiBold, fontSize: 13, color: '#FFF' },

  // Common
  hairline: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  vertDiv: { width: StyleSheet.hairlineWidth, backgroundColor: colors.border, alignSelf: 'stretch' },
  pressed: { opacity: 0.8 },

  // Overview card
  overviewCard: { padding: 14, gap: 0 },
  overviewHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 12 },
  cropAvatar: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  cropAvatarText: { fontFamily: fontFamilies.bold, fontSize: 15 },
  overviewTitles: { flex: 1, minWidth: 0, gap: 3 },
  fieldName: { fontFamily: fontFamilies.bold, fontSize: 17, color: colors.text },
  fieldCrop: { fontFamily: fontFamilies.regular, fontSize: 13, color: colors.textSecondary },
  metricsRow: { flexDirection: 'row', alignItems: 'center' },

  // Classification card
  classCard: { padding: 0, gap: 0 },
  classHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  classRule: { fontFamily: fontFamilies.semiBold, fontSize: 12, color: colors.textSecondary },
  classDescription: {
    fontFamily: fontFamilies.regular,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  classMetrics: { flexDirection: 'row', alignItems: 'center' },

  // Satellite card
  satCard: { padding: 0, gap: 0 },
  satMissionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  satMission: { flex: 1, minWidth: 0, fontFamily: fontFamilies.medium, fontSize: 12, color: colors.textSecondary },
  satStatsRow: { flexDirection: 'row', alignItems: 'center' },
  satStatCell: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  satStatVal: { fontFamily: fontFamilies.bold, fontSize: 18, color: colors.text },
  satStatLabel: { fontFamily: fontFamilies.medium, fontSize: 11, color: colors.muted, marginTop: 3 },
  satObsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 9,
    gap: 8,
  },
  satObsText: { fontFamily: fontFamilies.medium, fontSize: 12, color: colors.textSecondary, flex: 1 },
  satObsCloud: { fontFamily: fontFamilies.medium, fontSize: 12, color: colors.muted },
  anomalyBox: {
    margin: 10,
    marginTop: 0,
    backgroundColor: colors.warningSoft,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#F59E0B',
  },
  anomalyText: { fontFamily: fontFamilies.medium, fontSize: 12, color: '#78350F', lineHeight: 17 },
  pendingBox: { paddingHorizontal: 14, paddingVertical: 14 },
  pendingText: { fontFamily: fontFamilies.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  pendingZonesCard: { padding: 14, gap: 6 },
  pendingZonesTitle: { fontFamily: fontFamilies.semiBold, fontSize: 14, color: colors.text },
  dataSourceCard: { paddingHorizontal: 14, paddingVertical: 0 },

  // Weather card
  weatherCard: { padding: 0, gap: 0, overflow: 'hidden' },
  weatherGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  etRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  etLabel: { fontFamily: fontFamilies.regular, fontSize: 13, color: colors.textSecondary },
  etValue: { fontFamily: fontFamilies.semiBold, fontSize: 13, color: colors.text },
  alertBox: {
    margin: 10,
    backgroundColor: '#FEF3C7',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#F59E0B',
  },
  alertTitle: { fontFamily: fontFamilies.semiBold, fontSize: 12, color: '#92400E' },
  alertDesc: { fontFamily: fontFamilies.regular, fontSize: 12, color: '#78350F', lineHeight: 17, marginTop: 2 },

  // Map
  segmentedWrap: {
    flexDirection: 'row',
    backgroundColor: '#E5E5EA',
    borderRadius: 10,
    padding: 2,
    gap: 2,
  },
  mapFrame: {
    height: 230,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: '#EAECE8',
  },
  map: { flex: 1 },
  mapFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  mapFallbackText: { fontFamily: fontFamilies.regular, fontSize: 12, color: colors.muted },
  mapTag: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    backgroundColor: 'rgba(255,255,255,0.92)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    maxWidth: '80%',
  },
  mapTagText: { fontFamily: fontFamilies.medium, fontSize: 10.5, color: colors.text },
  mapTypeToggle: {
    position: 'absolute',
    right: 8,
    top: 8,
    backgroundColor: 'rgba(28,28,30,0.72)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  mapTypeToggleText: { fontFamily: fontFamilies.semiBold, fontSize: 11.5, color: '#FFFFFF' },
  ndviLegend: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  ndviLegendBar: { flex: 1, flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden' },
  ndviLegendSeg: { flex: 1 },
  ndviLegendVal: { fontFamily: fontFamilies.semiBold, fontSize: 10.5, color: colors.text },

  // Zone picker
  zonePicker: { flexDirection: 'row', gap: 8 },

  // Zone detail card
  zoneCard: { padding: 0, gap: 0 },
  zoneMetrics: { flexDirection: 'row', alignItems: 'center' },
  zoneMetricCell: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  zoneMetricVal: { fontFamily: fontFamilies.bold, fontSize: 18, color: colors.text },
  zoneMetricLabel: { fontFamily: fontFamilies.medium, fontSize: 11, color: colors.muted, marginTop: 3 },
  zoneInfoBlock: { paddingHorizontal: 14, paddingVertical: 10, gap: 4 },
  zoneInfoTitle: { fontFamily: fontFamilies.semiBold, fontSize: 11.5, letterSpacing: 0.3, color: colors.muted },
  zoneInfoText: { fontFamily: fontFamilies.regular, fontSize: 13.5, color: colors.text, lineHeight: 19 },
  zonePersistenceRow: { paddingHorizontal: 14, paddingVertical: 9 },
  zonePersistenceText: { fontFamily: fontFamilies.medium, fontSize: 12, color: colors.textSecondary },
  dispatchBtn: {
    margin: 12,
    marginTop: 4,
    backgroundColor: colors.primary,
    height: 46,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dispatchBtnText: { fontFamily: fontFamilies.semiBold, fontSize: 14, color: '#FFF' },

  // Savings card
  savingsCard: { padding: 14, gap: 0 },

  // Actions card
  actionsCard: { padding: 0, gap: 0 },

  // Inspections
  inspGroup: { padding: 0 },
  inspRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 12,
  },
  inspRowPressed: { backgroundColor: colors.surfaceSecondary },
  thumb: { width: 46, height: 46, borderRadius: 8, backgroundColor: colors.border },
  thumbPlaceholder: {
    width: 46,
    height: 46,
    borderRadius: 8,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbPlaceholderText: { fontFamily: fontFamilies.bold, fontSize: 10, color: colors.muted },
  inspMain: { flex: 1, gap: 3 },
  inspTopRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  inspDate: { fontFamily: fontFamilies.semiBold, fontSize: 13.5, color: colors.text, flex: 1 },
  inspNote: { fontFamily: fontFamilies.regular, fontSize: 12, color: colors.textSecondary, lineHeight: 16 },
  chevron: { fontFamily: fontFamilies.regular, fontSize: 20, color: '#C7C7CC' },
  inspDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: 72 },
});
