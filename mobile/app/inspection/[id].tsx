import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, ImageStyle, StyleSheet, View } from 'react-native';
import { Text } from '../../src/components/AppText';
import { useLocalSearchParams } from 'expo-router';

import { Badge } from '../../src/components/Badge';
import { Card } from '../../src/components/Card';
import { EmptyState } from '../../src/components/EmptyState';
import { Screen } from '../../src/components/Screen';
import { CACHE_KEYS, getField, getInspection } from '../../src/services/api';
import { getMemoryCache } from '../../src/services/offline';
import { colors } from '../../src/theme/colors';
import { fontFamilies, typography } from '../../src/theme/typography';
import { Field, Inspection } from '../../src/types/domain';

export default function InspectionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  // Instant hydration from memory cache (0ms perceived latency)
  const initialInsp = id ? getMemoryCache<Inspection>(CACHE_KEYS.INSPECTION(id)) : null;
  const initialField = initialInsp?.fieldId
    ? getMemoryCache<Field>(CACHE_KEYS.FIELD(initialInsp.fieldId))
    : null;

  const [inspection, setInspection] = useState<Inspection | null>(initialInsp);
  const [field, setField] = useState<Field | null>(initialField);
  const [loading, setLoading] = useState(!initialInsp);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    if (!inspection) setLoading(true);
    getInspection(id)
      .then(async (item) => {
        setInspection(item);
        setField(await getField(item.fieldId));
        setError(null);
      })
      .catch((nextError) => {
        if (!inspection) {
          setError(nextError instanceof Error ? nextError.message : 'Не удалось загрузить осмотр');
        }
      })
      .finally(() => setLoading(false));
  }, [id, inspection]);

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
      </View>
    );
  }

  if (!inspection) {
    return (
      <View style={styles.loader}>
        <Text style={styles.errorText}>Осмотр не найден.</Text>
      </View>
    );
  }

  return (
    <Screen contentStyle={styles.content}>
      {/* Top Header */}
      <View style={styles.header}>
        <View style={styles.headerMain}>
          <Text style={styles.screenTitle}>{field?.name ?? 'Поле'}</Text>
          <Text style={styles.headerMeta}>Акт осмотра #{inspection.id.slice(-8)}</Text>
        </View>
        {inspection.status === 'pending' ? (
          <Badge label="Офлайн-очередь" variant="warning" />
        ) : (
          <Badge label="Сохранено" variant="success" />
        )}
      </View>

      {/* Photo Frame */}
      {inspection.photoUrl ? (
        <Card style={styles.photoCard}>
          <Image source={{ uri: inspection.photoUrl }} style={styles.photo as ImageStyle} />
        </Card>
      ) : (
        <EmptyState
          title="Снимок не прикреплён"
          text="Осмотр сохранён только с текстовой заметкой агронома."
        />
      )}

      {/* Note Section */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>ЗАМЕТКА АГРОНОМА</Text>
        <Card style={styles.noteCard}>
          <Text style={styles.noteText}>
            {inspection.note || 'Текстовая заметка не добавлена.'}
          </Text>
        </Card>
      </View>

      {/* Details Inset Table */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>СВЕДЕНИЯ О ЗАПИСИ</Text>
        <Card style={styles.detailsTable}>
          <View style={styles.tableRow}>
            <Text style={styles.tableLabel}>Дата и время</Text>
            <Text style={styles.tableValue}>{formatDate(inspection.createdAt)}</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.tableRow}>
            <Text style={styles.tableLabel}>Культура участка</Text>
            <Text style={styles.tableValue}>{field?.cropType ?? '—'}</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.tableRow}>
            <Text style={styles.tableLabel}>GPS-координаты</Text>
            <Text style={styles.tableValueMono}>
              {inspection.latitude !== null && inspection.longitude !== null
                ? `${inspection.latitude.toFixed(6)}, ${inspection.longitude.toFixed(6)}`
                : 'Не зафиксированы'}
            </Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.tableRow}>
            <Text style={styles.tableLabel}>Хранилище</Text>
            <Text style={styles.tableValue}>Локальная SQLite</Text>
          </View>
        </Card>
      </View>

      {/* Agronomic Verification Note */}
      <View style={styles.verificationBox}>
        <Text style={styles.verificationTitle}>Верификация наземного обследования</Text>
        <Text style={styles.verificationText}>
          Фотоматериал привязан к сохранённому контуру поля для проверки спутниковых аномалий Sentinel-2 L2A.
        </Text>
      </View>
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
    paddingTop: 4,
    paddingBottom: 32,
    gap: 12,
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
    fontFamily: fontFamilies.semiBold,
    fontSize: 15,
    color: colors.danger,
  },
  errorText: {
    fontFamily: fontFamilies.regular,
    fontSize: 13,
    color: colors.textSecondary,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
  },
  headerMain: {
    gap: 2,
    flex: 1,
  },
  screenTitle: {
    fontFamily: fontFamilies.bold,
    fontSize: 18,
    color: colors.text,
  },
  headerMeta: {
    fontFamily: fontFamilies.regular,
    fontSize: 12.5,
    color: colors.muted,
  },

  // Photo Card
  photoCard: {
    padding: 0,
    overflow: 'hidden',
    borderRadius: 14,
  },
  photo: {
    width: '100%',
    height: 250,
    resizeMode: 'cover',
  },

  // Sections
  section: {
    gap: 6,
  },
  sectionLabel: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 11.5,
    letterSpacing: 0.5,
    color: colors.textSecondary,
    paddingHorizontal: 4,
  },
  noteCard: {
    padding: 14,
  },
  noteText: {
    fontFamily: fontFamilies.regular,
    fontSize: 14,
    color: colors.text,
    lineHeight: 20,
  },

  // Details Table
  detailsTable: {
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 9,
  },
  tableLabel: {
    fontFamily: fontFamilies.regular,
    fontSize: 13,
    color: colors.textSecondary,
  },
  tableValue: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 13.5,
    color: colors.text,
  },
  tableValueMono: {
    fontFamily: fontFamilies.medium,
    fontSize: 12,
    color: colors.text,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },

  // Verification Box
  verificationBox: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    gap: 3,
  },
  verificationTitle: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 12.5,
    color: colors.text,
  },
  verificationText: {
    fontFamily: fontFamilies.regular,
    fontSize: 11.5,
    color: colors.textSecondary,
    lineHeight: 16,
  },
});
