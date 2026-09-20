import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';

import { Text, TextInput } from '../../../src/components/AppText';
import { Card } from '../../../src/components/Card';
import { Screen } from '../../../src/components/Screen';
import {
  createYieldHistory,
  deleteYieldHistory,
  getField,
  listYieldHistory,
} from '../../../src/services/api';
import { colors } from '../../../src/theme/colors';
import { fontFamilies } from '../../../src/theme/typography';
import { Field, YieldHistoryRecord, YieldHistorySource } from '../../../src/types/domain';

const SOURCE_LABELS: Record<YieldHistorySource, string> = {
  farm_record: 'Учёт хозяйства',
  partner: 'Данные партнёра',
  official_stat: 'Открытая статистика',
};

export default function YieldHistoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [field, setField] = useState<Field | null>(null);
  const [records, setRecords] = useState<YieldHistoryRecord[]>([]);
  const [year, setYear] = useState(String(new Date().getFullYear() - 1));
  const [yieldValue, setYieldValue] = useState('');
  const [notes, setNotes] = useState('');
  const [source, setSource] = useState<YieldHistorySource>('farm_record');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [fieldData, historyData] = await Promise.all([getField(id), listYieldHistory(id)]);
      setField(fieldData);
      setRecords(historyData);
    } catch (error) {
      Alert.alert('Не удалось загрузить историю', error instanceof Error ? error.message : 'Повторите попытку.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  async function save() {
    if (!id || saving) return;
    const parsedYear = Number(year);
    const parsedYield = Number(yieldValue.replace(',', '.'));
    const currentYear = new Date().getFullYear();
    if (!Number.isInteger(parsedYear) || parsedYear < 1981 || parsedYear >= currentYear) {
      Alert.alert('Проверьте сезон', `Укажите завершённый год от 1981 до ${currentYear - 1}.`);
      return;
    }
    if (!Number.isFinite(parsedYield) || parsedYield <= 0 || parsedYield > 150) {
      Alert.alert('Проверьте урожайность', 'Введите фактическое значение в т/га больше 0.');
      return;
    }
    setSaving(true);
    try {
      await createYieldHistory(id, {
        seasonYear: parsedYear,
        cropType: field?.cropType,
        yieldTPerHa: parsedYield,
        source,
        notes: notes.trim(),
      });
      setYieldValue('');
      setNotes('');
      setYear(String(Math.max(1981, parsedYear - 1)));
      await load();
    } catch (error) {
      Alert.alert('Не удалось сохранить сезон', error instanceof Error ? error.message : 'Повторите попытку.');
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete(record: YieldHistoryRecord) {
    if (!id) return;
    Alert.alert(
      `Удалить сезон ${record.seasonYear}?`,
      'Модель перестроится без этого фактического значения.',
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Удалить',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteYieldHistory(id, record.id);
              await load();
            } catch (error) {
              Alert.alert('Ошибка удаления', error instanceof Error ? error.message : 'Повторите попытку.');
            }
          },
        },
      ]
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <Screen contentStyle={styles.content}>
      <View style={styles.heading}>
        <Text style={styles.title}>Фактическая урожайность</Text>
        <Text style={styles.subtitle}>
          {field?.name ?? 'Поле'} · {field?.cropType ?? 'культура не указана'}
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>ДОБАВИТЬ ЗАВЕРШЁННЫЙ СЕЗОН</Text>
        <Card style={styles.formCard}>
          <View style={styles.inputRow}>
            <View style={styles.inputCell}>
              <Text style={styles.inputLabel}>Год</Text>
              <TextInput
                value={year}
                onChangeText={setYear}
                keyboardType="number-pad"
                maxLength={4}
                style={styles.input}
                placeholder="2025"
                placeholderTextColor={colors.muted}
              />
            </View>
            <View style={styles.inputCell}>
              <Text style={styles.inputLabel}>Урожайность, т/га</Text>
              <TextInput
                value={yieldValue}
                onChangeText={setYieldValue}
                keyboardType="decimal-pad"
                style={styles.input}
                placeholder="2,35"
                placeholderTextColor={colors.muted}
              />
            </View>
          </View>

          <Text style={styles.inputLabel}>Источник факта</Text>
          <View style={styles.segmented}>
            {(['farm_record', 'partner', 'official_stat'] as YieldHistorySource[]).map((item) => (
              <Pressable
                key={item}
                onPress={() => setSource(item)}
                style={[styles.segment, source === item && styles.segmentActive]}
              >
                <Text style={[styles.segmentText, source === item && styles.segmentTextActive]} numberOfLines={2}>
                  {item === 'farm_record' ? 'Хозяйство' : item === 'partner' ? 'Партнёр' : 'Статистика'}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.inputLabel}>Примечание</Text>
          <TextInput
            value={notes}
            onChangeText={setNotes}
            multiline
            maxLength={500}
            style={[styles.input, styles.notesInput]}
            placeholder="Источник ведомости, гибрид, уборочная влажность"
            placeholderTextColor={colors.muted}
          />

          <Pressable
            onPress={() => void save()}
            disabled={saving}
            style={({ pressed }) => [styles.saveButton, pressed && styles.pressed, saving && styles.disabled]}
          >
            {saving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.saveText}>Сохранить сезон</Text>}
          </Pressable>
        </Card>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>ИСТОРИЯ ({records.length})</Text>
        {records.length === 0 ? (
          <Card style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>Фактических сезонов пока нет</Text>
            <Text style={styles.emptyText}>Для полевого прогноза требуется минимум четыре сезона одной культуры.</Text>
          </Card>
        ) : (
          <Card style={styles.listCard}>
            {records.map((record, index) => (
              <View key={record.id}>
                <Pressable onLongPress={() => confirmDelete(record)} style={({ pressed }) => [styles.recordRow, pressed && styles.pressed]}>
                  <View style={styles.yearBox}>
                    <Text style={styles.yearText}>{record.seasonYear}</Text>
                  </View>
                  <View style={styles.recordMain}>
                    <Text style={styles.recordCrop}>{record.cropType}</Text>
                    <Text style={styles.recordSource}>{SOURCE_LABELS[record.source]}{record.notes ? ` · ${record.notes}` : ''}</Text>
                  </View>
                  <Text style={styles.recordYield}>{record.yieldTPerHa.toFixed(2)} т/га</Text>
                </Pressable>
                {index < records.length - 1 ? <View style={styles.divider} /> : null}
              </View>
            ))}
          </Card>
        )}
        {records.length > 0 ? <Text style={styles.hint}>Удерживайте строку сезона, чтобы удалить её.</Text> : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>ИСТОЧНИКИ МОДЕЛИ</Text>
        <Card style={styles.sourceCard}>
          <SourceRow title="Sentinel-2 L2A" detail="NDVI и NDMI по контуру поля" />
          <View style={styles.divider} />
          <SourceRow title="NASA POWER" detail="температура и осадки по сезонам" />
          <View style={styles.divider} />
          <SourceRow title="ERA5 · Copernicus CDS" detail="через Open-Meteo Archive API: ET₀ и метеоряд" />
          <View style={styles.divider} />
          <SourceRow title="Открытая статистика РК" detail="только ориентир до точной привязки к району и культуре" />
        </Card>
      </View>
    </Screen>
  );
}

function SourceRow({ title, detail }: { title: string; detail: string }) {
  return (
    <View style={styles.sourceRow}>
      <Text style={styles.sourceTitle}>{title}</Text>
      <Text style={styles.sourceDetail}>{detail}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  content: { paddingTop: 4, paddingBottom: 36, gap: 14 },
  heading: { gap: 3 },
  title: { fontFamily: fontFamilies.bold, fontSize: 21, color: colors.text },
  subtitle: { fontFamily: fontFamilies.regular, fontSize: 13, color: colors.textSecondary },
  section: { gap: 7 },
  sectionLabel: { fontFamily: fontFamilies.semiBold, fontSize: 11.5, letterSpacing: 0.6, color: colors.textSecondary, paddingHorizontal: 2 },
  formCard: { padding: 14, gap: 9 },
  inputRow: { flexDirection: 'row', gap: 10 },
  inputCell: { flex: 1, gap: 5 },
  inputLabel: { fontFamily: fontFamilies.semiBold, fontSize: 11.5, color: colors.textSecondary },
  input: {
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.surfaceSecondary,
    paddingHorizontal: 11,
    paddingVertical: 9,
    fontFamily: fontFamilies.medium,
    fontSize: 14,
    color: colors.text,
  },
  notesInput: { minHeight: 72, textAlignVertical: 'top' },
  segmented: { flexDirection: 'row', backgroundColor: '#E5E5EA', borderRadius: 9, padding: 2, gap: 2 },
  segment: { flex: 1, minHeight: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 7, paddingHorizontal: 3 },
  segmentActive: { backgroundColor: colors.surface },
  segmentText: { fontFamily: fontFamilies.medium, fontSize: 11, color: colors.textSecondary, textAlign: 'center' },
  segmentTextActive: { fontFamily: fontFamilies.semiBold, color: colors.text },
  saveButton: { height: 46, borderRadius: 9, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  saveText: { fontFamily: fontFamilies.semiBold, fontSize: 14, color: '#FFFFFF' },
  disabled: { opacity: 0.55 },
  pressed: { opacity: 0.72 },
  emptyCard: { padding: 14, gap: 4 },
  emptyTitle: { fontFamily: fontFamilies.semiBold, fontSize: 14, color: colors.text },
  emptyText: { fontFamily: fontFamilies.regular, fontSize: 12.5, lineHeight: 18, color: colors.textSecondary },
  listCard: { padding: 0, gap: 0 },
  recordRow: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 9 },
  yearBox: { width: 48, height: 34, borderRadius: 7, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  yearText: { fontFamily: fontFamilies.bold, fontSize: 12, color: colors.primaryDark },
  recordMain: { flex: 1, minWidth: 0, gap: 2 },
  recordCrop: { fontFamily: fontFamilies.semiBold, fontSize: 13, color: colors.text },
  recordSource: { fontFamily: fontFamilies.regular, fontSize: 10.5, lineHeight: 14, color: colors.muted },
  recordYield: { fontFamily: fontFamilies.bold, fontSize: 13, color: colors.text },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  hint: { fontFamily: fontFamilies.regular, fontSize: 10.5, color: colors.muted, paddingHorizontal: 2 },
  sourceCard: { padding: 0, gap: 0 },
  sourceRow: { paddingHorizontal: 14, paddingVertical: 10, gap: 2 },
  sourceTitle: { fontFamily: fontFamilies.semiBold, fontSize: 12.5, color: colors.text },
  sourceDetail: { fontFamily: fontFamilies.regular, fontSize: 11.5, lineHeight: 16, color: colors.textSecondary },
});
