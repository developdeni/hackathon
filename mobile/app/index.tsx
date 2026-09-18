import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { Badge } from '../src/components/Badge';
import { Card } from '../src/components/Card';
import { Screen } from '../src/components/Screen';
import { API_URL, getServerHealth, listFields } from '../src/services/api';
import { colors } from '../src/theme/colors';
import { fontFamilies, typography } from '../src/theme/typography';
import { Field } from '../src/types/domain';

export default function FieldsScreen() {
  const router = useRouter();
  const [fields, setFields] = useState<Field[]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [health, items] = await Promise.all([getServerHealth(), listFields()]);
      setConnected(health.status === 'ok' && health.database === 'connected');
      setFields(items);
    } catch (nextError) {
      setConnected(false);
      setError(nextError instanceof Error ? nextError.message : 'Не удалось подключиться к серверу');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const inspectionCount = fields.reduce((sum, field) => sum + field.inspectionCount, 0);
  const totalArea = fields.reduce((sum, field) => sum + field.areaHa, 0);

  return (
    <Screen contentStyle={styles.screen}>
      {/* Top Header: Technical Farm Info & Connection */}
      <View style={styles.header}>
        <View style={styles.headerMain}>
          <Text style={styles.screenTitle}>Tanap AI</Text>
          <Text style={styles.farmSubtitle}>Демо-хозяйство • Акмолинская обл.</Text>
        </View>

        <View style={[styles.statusBadge, connected ? styles.statusOnline : styles.statusOffline]}>
          <View style={[styles.statusDot, connected ? styles.dotOnline : styles.dotOffline]} />
          <Text style={[styles.statusText, connected ? styles.textOnline : styles.textOffline]}>
            {connected ? 'Сервер онлайн' : 'Офлайн'}
          </Text>
        </View>
      </View>

      {/* Farm Metrics: Single Compact Inset Card */}
      <Card style={styles.metricsTable}>
        <View style={styles.metricCell}>
          <Text style={styles.metricValue}>{fields.length}</Text>
          <Text style={styles.metricLabel}>поля</Text>
        </View>
        <View style={styles.metricDivider} />
        <View style={styles.metricCell}>
          <Text style={styles.metricValue}>{inspectionCount}</Text>
          <Text style={styles.metricLabel}>осмотров</Text>
        </View>
        <View style={styles.metricDivider} />
        <View style={styles.metricCell}>
          <Text style={styles.metricValue}>{totalArea.toFixed(1)}</Text>
          <Text style={styles.metricLabel}>га всего</Text>
        </View>
      </Card>

      {/* Section Header */}
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>УЧАСТКИ ХОЗЯЙСТВА ({fields.length})</Text>
        <Text style={styles.serverHost} numberOfLines={1}>{API_URL.replace('http://', '')}</Text>
      </View>

      {/* Main Content Area */}
      {loading ? (
        <Card style={styles.centerBox}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.helperText}>Загрузка списка полей…</Text>
        </Card>
      ) : error ? (
        <Card style={styles.errorBox}>
          <Text style={styles.errorTitle}>Связь с сервером прервана</Text>
          <Text style={styles.errorDescription}>{error}</Text>
          <Pressable onPress={load} style={styles.retryButton}>
            <Text style={styles.retryButtonText}>Повторить запрос</Text>
          </Pressable>
        </Card>
      ) : (
        <Card style={styles.fieldsGroup}>
          {fields.map((field, index) => {
            const isLast = index === fields.length - 1;
            return (
              <View key={field.id}>
                <Pressable
                  onPress={() => router.push({ pathname: '/field/[id]', params: { id: field.id } })}
                  style={({ pressed }) => [styles.fieldRow, pressed && styles.rowPressed]}
                >
                  <View style={styles.fieldMain}>
                    <View style={styles.nameRow}>
                      <Text style={styles.fieldName}>{field.name}</Text>
                      {field.isDemo && <Badge label="ДЕМО" variant="demo" />}
                    </View>
                    <Text style={styles.fieldMeta}>
                      {field.cropType} • {field.areaHa.toFixed(1)} га • 4 точки контура
                    </Text>
                  </View>

                  <View style={styles.fieldRight}>
                    <Text style={styles.inspectionCount}>
                      {field.inspectionCount} осм.
                    </Text>
                    <Text style={styles.chevron}>›</Text>
                  </View>
                </Pressable>
                {!isLast && <View style={styles.rowDivider} />}
              </View>
            );
          })}
        </Card>
      )}

      {/* Technical Footer */}
      <View style={styles.footerBox}>
        <Text style={styles.footerText}>
          Локальный API: FastAPI / SQLite. Координаты границ и площади являются демонстрационными.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 28,
    gap: 14,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  headerMain: {
    gap: 2,
  },
  screenTitle: {
    ...typography.screenTitle,
    color: colors.text,
  },
  farmSubtitle: {
    ...typography.caption,
    color: colors.textSecondary,
  },

  // Status Badge
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  statusOnline: {
    backgroundColor: colors.successSoft,
    borderColor: '#C8E6C9',
  },
  statusOffline: {
    backgroundColor: colors.dangerSoft,
    borderColor: '#FFCDD2',
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  dotOnline: {
    backgroundColor: colors.success,
  },
  dotOffline: {
    backgroundColor: colors.danger,
  },
  statusText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 11,
  },
  textOnline: {
    color: colors.success,
  },
  textOffline: {
    color: colors.danger,
  },

  // Metrics Table
  metricsTable: {
    flexDirection: 'row',
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  metricCell: {
    flex: 1,
    alignItems: 'center',
    gap: 1,
  },
  metricValue: {
    ...typography.headline,
    color: colors.text,
  },
  metricLabel: {
    ...typography.caption,
    color: colors.muted,
  },
  metricDivider: {
    width: StyleSheet.hairlineWidth,
    height: 24,
    backgroundColor: colors.border,
    alignSelf: 'center',
  },

  // Section Header
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    marginTop: 2,
  },
  sectionTitle: {
    ...typography.sectionHeader,
    color: colors.textSecondary,
  },
  serverHost: {
    ...typography.metaMono,
    color: colors.muted,
  },

  // Fields Inset Grouped Table
  fieldsGroup: {
    padding: 0,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
  },
  rowPressed: {
    backgroundColor: '#F5F5F7',
  },
  fieldMain: {
    flex: 1,
    gap: 3,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  fieldName: {
    ...typography.headline,
    color: colors.text,
  },
  fieldMeta: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  fieldRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  inspectionCount: {
    ...typography.caption,
    color: colors.muted,
  },
  chevron: {
    fontSize: 18,
    color: colors.border,
    fontWeight: '600',
  },
  rowDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: 14,
  },

  // Loading & Error states
  centerBox: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 8,
  },
  helperText: {
    ...typography.caption,
    color: colors.muted,
  },
  errorBox: {
    padding: 16,
    gap: 6,
    alignItems: 'center',
    backgroundColor: '#FFF8F8',
    borderColor: '#FFCDD2',
  },
  errorTitle: {
    ...typography.headline,
    color: colors.danger,
  },
  errorDescription: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    marginTop: 6,
  },
  retryButtonText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 13,
    color: '#FFFFFF',
  },

  // Footer
  footerBox: {
    paddingHorizontal: 4,
    marginTop: 2,
  },
  footerText: {
    ...typography.caption,
    color: colors.muted,
    lineHeight: 16,
  },
});
