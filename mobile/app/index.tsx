import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '../src/components/AppText';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';

import { Avatar } from '../src/components/Avatar';
import { Badge } from '../src/components/Badge';
import { Card } from '../src/components/Card';
import { EmptyState } from '../src/components/EmptyState';
import { Screen } from '../src/components/Screen';
import { useAuth } from '../src/contexts/AuthContext';
import {
  deleteField,
  getServerHealth,
  listFieldsForProfile,
  listProfiles,
} from '../src/services/api';
import { colors } from '../src/theme/colors';
import { fontFamilies } from '../src/theme/typography';
import { FarmProfile, Field } from '../src/types/domain';

export default function FieldsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const params = useLocalSearchParams<{ profileId?: string }>();
  const [profiles, setProfiles] = useState<FarmProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (params.profileId) {
      setSelectedProfileId(params.profileId);
    }
  }, [params.profileId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [health, profileItems] = await Promise.all([getServerHealth(), listProfiles()]);
      const profileWithFields = profileItems.find((profile) => profile.fieldCount > 0);
      const nextProfileId = params.profileId ?? selectedProfileId ?? profileWithFields?.id ?? profileItems[0]?.id ?? null;
      const fieldItems = nextProfileId ? await listFieldsForProfile(nextProfileId) : [];
      setConnected(health.status === 'ok' && health.database === 'connected');
      setProfiles(profileItems);
      setSelectedProfileId(nextProfileId);
      setFields(fieldItems);
    } catch (nextError) {
      setConnected(false);
      setError(nextError instanceof Error ? nextError.message : 'Не удалось подключиться к серверу');
    } finally {
      setLoading(false);
    }
  }, [params.profileId, selectedProfileId]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) ?? profiles[0] ?? null,
    [profiles, selectedProfileId],
  );
  const totalArea = fields.reduce((sum, field) => sum + field.areaHa, 0);
  const inspectionCount = fields.reduce((sum, field) => sum + field.inspectionCount, 0);

  async function chooseProfile(profileId: string) {
    setSelectedProfileId(profileId);
    setLoading(true);
    setError(null);
    try {
      setFields(await listFieldsForProfile(profileId));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Не удалось загрузить участки профиля');
    } finally {
      setLoading(false);
    }
  }

  function confirmDelete(field: Field) {
    Alert.alert(
      'Удалить участок?',
      `Участок «${field.name}» и его осмотры будут удалены из локальной базы на ноутбуке.`,
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Удалить',
          style: 'destructive',
          onPress: () => {
            void removeField(field.id);
          },
        },
      ],
    );
  }

  async function removeField(fieldId: string) {
    try {
      await deleteField(fieldId);
      setFields((current) => current.filter((field) => field.id !== fieldId));
    } catch (nextError) {
      Alert.alert('Не удалось удалить', nextError instanceof Error ? nextError.message : 'Повторите попытку.');
    }
  }

  return (
    <Screen contentStyle={styles.screen}>
      <View style={styles.header}>
        <View style={styles.headerMain}>
          <Text style={styles.screenTitle}>Участки</Text>
          <Text style={styles.screenSubtitle}>
            {selectedProfile ? `${selectedProfile.name} • ${selectedProfile.region || 'регион не указан'}` : 'Профиль не выбран'}
          </Text>
        </View>
        <View style={styles.headerRight}>
          <View style={[styles.statusDot, connected ? styles.statusDotOnline : styles.statusDotOffline]} />
          <Pressable
            onPress={() => router.push('/profile/me')}
            style={({ pressed }) => [styles.avatarButton, pressed && styles.pressed]}
          >
            {user ? (
              <Avatar name={user.name} size={36} />
            ) : (
              <View style={styles.avatarPlaceholder} />
            )}
          </Pressable>
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.profileSegmentRow}
      >
        {profiles.map((profile) => {
          const selected = profile.id === selectedProfile?.id;
          return (
            <Pressable
              key={profile.id}
              onPress={() => void chooseProfile(profile.id)}
              style={[styles.profileSegmentTab, selected && styles.profileSegmentTabActive]}
            >
              <Text
                style={[styles.profileSegmentText, selected && styles.profileSegmentTextActive]}
                numberOfLines={1}
              >
                {profile.name}
              </Text>
            </Pressable>
          );
        })}
        <Pressable
          onPress={() => router.push('/profile/new')}
          style={({ pressed }) => [styles.addChip, pressed && styles.pressed]}
        >
          <Text style={styles.addChipText}>+ профиль</Text>
        </Pressable>
      </ScrollView>

      <Card style={styles.summaryCard}>
        <SummaryCell value={fields.length} label="участков" />
        <View style={styles.summaryDivider} />
        <SummaryCell value={totalArea.toFixed(1)} label="га" />
        <View style={styles.summaryDivider} />
        <SummaryCell value={inspectionCount} label="осмотров" />
      </Card>

      <View style={styles.actionsRow}>
        <Pressable
          disabled={!selectedProfile}
          onPress={() => selectedProfile && router.push({ pathname: '/field/new', params: { profileId: selectedProfile.id } })}
          style={({ pressed }) => [styles.primaryButton, (!selectedProfile || pressed) && styles.buttonPressed]}
        >
          <Text style={styles.primaryButtonText}>Добавить участок</Text>
        </Pressable>
        <Pressable onPress={load} style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}>
          <Text style={styles.secondaryButtonText}>Обновить</Text>
        </Pressable>
      </View>

      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>СПИСОК УЧАСТКОВ</Text>
        <Text style={styles.sectionHint} numberOfLines={1}>удержите, чтобы удалить</Text>
      </View>

      {loading ? (
        <Card style={styles.centerBox}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.helperText}>Загрузка данных…</Text>
        </Card>
      ) : error ? (
        <Card style={styles.errorBox}>
          <Text style={styles.errorTitle}>Нет связи с локальным API</Text>
          <Text style={styles.errorDescription}>{error}</Text>
          <Pressable onPress={load} style={styles.retryButton}>
            <Text style={styles.retryButtonText}>Повторить</Text>
          </Pressable>
        </Card>
      ) : fields.length === 0 ? (
        <EmptyState
          title="Участков нет"
          text="Создайте первый участок: название, культура, площадь и контур будут сохранены в SQLite."
        />
      ) : (
        <Card style={styles.fieldsGroup}>
          {fields.map((field, index) => (
            <View key={field.id}>
              <Pressable
                onPress={() => router.push({ pathname: '/field/[id]', params: { id: field.id } })}
                onLongPress={() => confirmDelete(field)}
                delayLongPress={400}
                style={({ pressed }) => [styles.fieldRow, pressed && styles.rowPressed]}
              >
                <View style={[styles.fieldAccent, { backgroundColor: getCropAccent(field.cropType).accent }]} />

                <View style={styles.fieldCode}>
                  <Text style={[styles.fieldCodeText, { color: getCropAccent(field.cropType).text }]}>
                    {getCropCode(field.cropType)}
                  </Text>
                </View>

                <View style={styles.fieldMain}>
                  <View style={styles.fieldTitleRow}>
                    <Text style={styles.fieldName} numberOfLines={1}>{field.name}</Text>
                    {field.isDemo && <Badge label="стартовое" variant="muted" />}
                  </View>
                  <Text style={styles.fieldMeta} numberOfLines={1}>
                    {field.cropType} • {field.areaHa.toFixed(1)} га
                  </Text>
                  <Text style={styles.fieldMetaSmall} numberOfLines={1}>
                    Осмотров: {field.inspectionCount}
                  </Text>
                </View>

                <Text style={styles.chevron}>›</Text>
              </Pressable>
              {index < fields.length - 1 && <View style={styles.rowDivider} />}
            </View>
          ))}
        </Card>
      )}
    </Screen>
  );
}

function SummaryCell({ value, label }: { value: string | number; label: string }) {
  return (
    <View style={styles.summaryCell}>
      <Text style={styles.summaryValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
        {value}
      </Text>
      <Text style={styles.summaryLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

function getCropAccent(cropType: string) {
  const t = cropType.toLowerCase();
  if (t.includes('пшениц') || t.includes('ячмен') || t.includes('овёс') || t.includes('овес')) {
    return { accent: colors.cropWheatText, bg: colors.cropWheatBg, text: colors.cropWheatText };
  }
  if (t.includes('рапс') || t.includes('подсолнеч')) {
    return { accent: colors.cropRapeseedText, bg: colors.cropRapeseedBg, text: colors.cropRapeseedText };
  }
  return { accent: colors.cropPotatoText, bg: colors.cropPotatoBg, text: colors.cropPotatoText };
}

function getCropCode(cropType: string) {
  const normalized = cropType.trim().toUpperCase();
  if (!normalized) return 'ПЛ';
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 2);
  return words.slice(0, 2).map((word) => word[0]).join('');
}

const styles = StyleSheet.create({
  screen: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 28,
    gap: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerMain: {
    flex: 1,
    gap: 3,
  },
  screenTitle: {
    fontFamily: fontFamilies.bold,
    fontSize: 20,
    color: colors.text,
  },
  screenSubtitle: {
    fontFamily: fontFamilies.regular,
    fontSize: 12.5,
    lineHeight: 17,
    color: colors.textSecondary,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusDotOnline: {
    backgroundColor: colors.success,
  },
  statusDotOffline: {
    backgroundColor: colors.danger,
  },
  avatarButton: {
    borderRadius: 18,
    overflow: 'hidden',
  },
  avatarPlaceholder: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceSecondary,
  },
  profileSegmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingRight: 4,
  },
  profileSegmentTab: {
    minHeight: 36,
    maxWidth: 220,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    backgroundColor: '#E5E5EA',
  },
  profileSegmentTabActive: {
    backgroundColor: colors.primary,
  },
  profileSegmentText: {
    fontFamily: fontFamilies.medium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  profileSegmentTextActive: {
    fontFamily: fontFamilies.semiBold,
    color: '#FFFFFF',
  },
  addChip: {
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addChipText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 12,
    color: colors.primary,
  },
  summaryCard: {
    flexDirection: 'row',
    paddingVertical: 12,
  },
  summaryCell: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  summaryValue: {
    fontFamily: fontFamilies.bold,
    fontSize: 17,
    color: colors.text,
  },
  summaryLabel: {
    fontFamily: fontFamilies.medium,
    fontSize: 11,
    color: colors.textSecondary,
  },
  summaryDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  primaryButton: {
    flex: 1,
    minHeight: 46,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 14,
    color: '#FFFFFF',
  },
  secondaryButton: {
    minHeight: 46,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 14,
    color: colors.text,
  },
  buttonPressed: {
    opacity: 0.72,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 4,
    marginTop: 2,
  },
  sectionTitle: {
    flexShrink: 0,
    fontFamily: fontFamilies.semiBold,
    fontSize: 12,
    color: colors.textSecondary,
  },
  sectionHint: {
    flexShrink: 1,
    fontFamily: fontFamilies.regular,
    fontSize: 11,
    color: colors.muted,
    textAlign: 'right',
  },
  fieldsGroup: {
    padding: 0,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 0,
    paddingRight: 12,
    paddingVertical: 12,
    minHeight: 72,
  },
  rowPressed: {
    backgroundColor: colors.surfaceSecondary,
  },
  fieldAccent: {
    alignSelf: 'stretch',
    width: 3,
    borderRadius: 2,
  },
  fieldCode: {
    width: 42,
    height: 42,
    borderRadius: 8,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fieldCodeText: {
    fontFamily: fontFamilies.bold,
    fontSize: 13,
    color: colors.primaryDark,
  },
  fieldMain: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  fieldTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  fieldName: {
    flex: 1,
    minWidth: 0,
    fontFamily: fontFamilies.semiBold,
    fontSize: 15,
    color: colors.text,
  },
  fieldMeta: {
    fontFamily: fontFamilies.regular,
    fontSize: 12.5,
    color: colors.textSecondary,
  },
  fieldMetaSmall: {
    fontFamily: fontFamilies.medium,
    fontSize: 11.5,
    color: colors.muted,
  },
  chevron: {
    flexShrink: 0,
    fontFamily: fontFamilies.regular,
    fontSize: 20,
    color: colors.muted,
  },
  rowDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: 69,
  },
  centerBox: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 8,
  },
  helperText: {
    fontFamily: fontFamilies.medium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  errorBox: {
    padding: 16,
    gap: 8,
  },
  errorTitle: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 15,
    color: colors.danger,
  },
  errorDescription: {
    fontFamily: fontFamilies.regular,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  retryButton: {
    minHeight: 44,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  retryButtonText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 14,
    color: '#FFFFFF',
  },
  pressed: {
    opacity: 0.72,
  },
});
