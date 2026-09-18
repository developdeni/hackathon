import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, ImageStyle, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import { Badge } from '../../src/components/Badge';
import { Card } from '../../src/components/Card';
import { EmptyState } from '../../src/components/EmptyState';
import { Screen } from '../../src/components/Screen';
import { getField, getInspection } from '../../src/services/api';
import { colors } from '../../src/theme/colors';
import { fontFamilies, typography } from '../../src/theme/typography';
import { Field, Inspection } from '../../src/types/domain';

export default function InspectionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [field, setField] = useState<Field | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    getInspection(id)
      .then(async (item) => {
        setInspection(item);
        setField(await getField(item.fieldId));
        setError(null);
      })
      .catch((nextError) => setError(nextError instanceof Error ? nextError.message : 'Не удалось загрузить осмотр'))
      .finally(() => setLoading(false));
  }, [id]);

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
        <Badge label="Сохранено" variant="success" />
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

      {/* Technical Status Callout */}
      <View style={styles.technicalBox}>
        <Text style={styles.technicalTitle}>Статус AI-обработки</Text>
        <Text style={styles.technicalText}>
          Анализ не выполнялся. Фотография сохранена на ноутбуке в исходном разрешении и готова к пакетной обработке моделью детекции на этапе 2.
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
  },
  screenTitle: {
    ...typography.screenTitle,
    color: colors.text,
  },
  headerMeta: {
    ...typography.metaMono,
    color: colors.muted,
  },

  // Photo Card
  photoCard: {
    padding: 0,
    overflow: 'hidden',
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
    ...typography.sectionHeader,
    color: colors.textSecondary,
    paddingHorizontal: 4,
  },
  noteCard: {
    padding: 14,
  },
  noteText: {
    ...typography.body,
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
    ...typography.caption,
    color: colors.textSecondary,
  },
  tableValue: {
    ...typography.captionBold,
    color: colors.text,
  },
  tableValueMono: {
    ...typography.metaMono,
    color: colors.text,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
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
});
