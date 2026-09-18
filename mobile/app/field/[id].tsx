import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import MapView, { Polygon } from 'react-native-maps';

import { Badge } from '../../src/components/Badge';
import { Card } from '../../src/components/Card';
import { EmptyState } from '../../src/components/EmptyState';
import { Screen } from '../../src/components/Screen';
import { getField, listInspections } from '../../src/services/api';
import { colors } from '../../src/theme/colors';
import { fontFamilies, typography } from '../../src/theme/typography';
import { Field, Inspection } from '../../src/types/domain';

export default function FieldScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [field, setField] = useState<Field | null>(null);
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [nextField, nextInspections] = await Promise.all([getField(id), listInspections(id)]);
      setField(nextField);
      setInspections(nextInspections);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Не удалось загрузить данные поля');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const region = useMemo(() => {
    if (!field) return undefined;
    const latitudes = field.boundary.map((point) => point.latitude);
    const longitudes = field.boundary.map((point) => point.longitude);
    const minLat = Math.min(...latitudes);
    const maxLat = Math.max(...latitudes);
    const minLng = Math.min(...longitudes);
    const maxLng = Math.max(...longitudes);
    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLng + maxLng) / 2,
      latitudeDelta: Math.max((maxLat - minLat) * 1.8, 0.02),
      longitudeDelta: Math.max((maxLng - minLng) * 1.8, 0.02),
    };
  }, [field]);

  if (loading) {
    return (
      <View style={styles.loader}>
        <ActivityIndicator size="small" color={colors.primary} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.loader}>
        <Text style={styles.errorTitle}>Ошибка загрузки</Text>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable onPress={load} style={styles.retryButton}>
          <Text style={styles.retryText}>Повторить</Text>
        </Pressable>
      </View>
    );
  }

  if (!field || !region) {
    return (
      <View style={styles.loader}>
        <Text style={styles.errorText}>Поле не найдено.</Text>
      </View>
    );
  }

  return (
    <Screen contentStyle={styles.content}>
      {/* Field Overview Card: Inset Grouped Table */}
      <Card style={styles.overviewCard}>
        <View style={styles.overviewHeader}>
          <View style={styles.nameRow}>
            <Text style={styles.fieldName}>{field.name}</Text>
            {field.isDemo && <Badge label="ДЕМО" variant="demo" />}
          </View>
          <Text style={styles.fieldId}>ID: {field.id}</Text>
        </View>

        <View style={styles.divider} />

        <View style={styles.tableRow}>
          <Text style={styles.tableLabel}>Культура</Text>
          <Text style={styles.tableValue}>{field.cropType}</Text>
        </View>

        <View style={styles.divider} />

        <View style={styles.tableRow}>
          <Text style={styles.tableLabel}>Площадь</Text>
          <Text style={styles.tableValue}>{field.areaHa.toFixed(1)} га</Text>
        </View>

        <View style={styles.divider} />

        <View style={styles.tableRow}>
          <Text style={styles.tableLabel}>Точек контура</Text>
          <Text style={styles.tableValue}>{field.boundary.length} вершины</Text>
        </View>
      </Card>

      {/* Map Viewport */}
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>КОНТУР И СПУТНИКОВАЯ КАРТА</Text>
      </View>

      <View style={styles.mapFrame}>
        {Platform.OS === 'web' ? (
          <View style={styles.mapFallback}>
            <Text style={styles.mapFallbackText}>Карта доступна на мобильном устройстве</Text>
          </View>
        ) : (
          <MapView style={styles.map} initialRegion={region}>
            <Polygon
              coordinates={field.boundary}
              fillColor="rgba(27, 94, 32, 0.25)"
              strokeColor={colors.primary}
              strokeWidth={2}
            />
          </MapView>
        )}

        <View style={styles.mapTag}>
          <Text style={styles.mapTagText}>Условная граница полигона</Text>
        </View>
      </View>

      {/* Technical Status Callout */}
      <View style={styles.technicalBox}>
        <Text style={styles.technicalTitle}>Спутниковая аналитика (NDVI)</Text>
        <Text style={styles.technicalText}>
          Подключение спутниковых снимков Sentinel/Landsat и расчёт вегетационных индексов планируется на этапе 3.
        </Text>
      </View>

      {/* Primary Action Button */}
      <Pressable
        onPress={() => router.push({ pathname: '/field/[id]/new-inspection', params: { id: field.id } })}
        style={({ pressed }) => [styles.actionButton, pressed && styles.actionPressed]}
      >
        <Text style={styles.actionButtonText}>+ Новый осмотр поля</Text>
      </Pressable>

      {/* Inspections History Section */}
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>ЖУРНАЛ ОСМОТРОВ ({inspections.length})</Text>
      </View>

      {inspections.length === 0 ? (
        <EmptyState
          title="Осмотры отсутствуют"
          text="Для этого поля пока не зафиксировано ни одного выездного наблюдения."
        />
      ) : (
        <Card style={styles.inspectionsGroup}>
          {inspections.map((inspection, index) => {
            const isLast = index === inspections.length - 1;
            return (
              <View key={inspection.id}>
                <Pressable
                  onPress={() => router.push({ pathname: '/inspection/[id]', params: { id: inspection.id } })}
                  style={({ pressed }) => [styles.inspectionRow, pressed && styles.rowPressed]}
                >
                  {inspection.photoUrl ? (
                    <Image source={{ uri: inspection.photoUrl }} style={styles.thumbnail} />
                  ) : (
                    <View style={styles.noThumbnail}>
                      <Text style={styles.noThumbnailText}>Акт</Text>
                    </View>
                  )}

                  <View style={styles.inspectionMain}>
                    <View style={styles.inspectionDateRow}>
                      <Text style={styles.inspectionDate}>{formatDate(inspection.createdAt)}</Text>
                      <Badge label="Сохранено" variant="success" />
                    </View>
                    <Text numberOfLines={1} style={styles.inspectionNote}>
                      {inspection.note || 'Без текстового описания'}
                    </Text>
                  </View>

                  <Text style={styles.chevron}>›</Text>
                </Pressable>
                {!isLast && <View style={styles.rowDivider} />}
              </View>
            );
          })}
        </Card>
      )}
    </Screen>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 32,
    gap: 14,
  },
  loader: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    padding: 24,
    gap: 8,
  },
  errorTitle: {
    ...typography.headline,
    color: colors.danger,
  },
  errorText: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    marginTop: 6,
  },
  retryText: {
    fontFamily: fontFamilies.semiBold,
    color: '#FFFFFF',
    fontSize: 13,
  },

  // Overview Card
  overviewCard: {
    padding: 14,
    gap: 10,
  },
  overviewHeader: {
    gap: 2,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  fieldName: {
    ...typography.screenTitle,
    color: colors.text,
  },
  fieldId: {
    ...typography.metaMono,
    color: colors.muted,
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  tableLabel: {
    ...typography.body,
    color: colors.textSecondary,
  },
  tableValue: {
    ...typography.headline,
    color: colors.text,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },

  // Section Headers
  sectionHeaderRow: {
    paddingHorizontal: 4,
    marginTop: 2,
  },
  sectionTitle: {
    ...typography.sectionHeader,
    color: colors.textSecondary,
  },

  // Map Frame
  mapFrame: {
    height: 190,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: '#EAECE8',
  },
  map: {
    flex: 1,
  },
  mapFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mapFallbackText: {
    ...typography.caption,
    color: colors.muted,
  },
  mapTag: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    backgroundColor: 'rgba(255,255,255,0.92)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  mapTagText: {
    ...typography.metaMono,
    fontSize: 10.5,
    color: colors.textSecondary,
  },

  // Technical Box
  technicalBox: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 12,
    gap: 3,
  },
  technicalTitle: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 12.5,
    color: colors.text,
  },
  technicalText: {
    ...typography.caption,
    color: colors.textSecondary,
    lineHeight: 16,
  },

  // Action Button
  actionButton: {
    backgroundColor: colors.primary,
    height: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionPressed: {
    opacity: 0.8,
  },
  actionButtonText: {
    ...typography.button,
    color: '#FFFFFF',
  },

  // Inspections Inset Group
  inspectionsGroup: {
    padding: 0,
  },
  inspectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  rowPressed: {
    backgroundColor: '#F5F5F7',
  },
  thumbnail: {
    width: 42,
    height: 42,
    borderRadius: 6,
    backgroundColor: colors.border,
  },
  noThumbnail: {
    width: 42,
    height: 42,
    borderRadius: 6,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noThumbnailText: {
    ...typography.metaMono,
    fontSize: 10,
    color: colors.muted,
  },
  inspectionMain: {
    flex: 1,
    gap: 2,
  },
  inspectionDateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  inspectionDate: {
    ...typography.headline,
    fontSize: 13.5,
    color: colors.text,
  },
  inspectionNote: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  chevron: {
    fontSize: 18,
    color: colors.border,
    fontWeight: '600',
  },
  rowDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: 64,
  },
});
