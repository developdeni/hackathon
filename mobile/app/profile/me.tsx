import { useEffect } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../../src/components/AppText';
import { Avatar } from '../../src/components/Avatar';
import { Card } from '../../src/components/Card';
import { Screen } from '../../src/components/Screen';
import { useAuth } from '../../src/contexts/AuthContext';
import { useI18n, type Lang } from '../../src/i18n';
import { colors } from '../../src/theme/colors';
import { fontFamilies } from '../../src/theme/typography';

export default function MyProfileScreen() {
  const { user, logout, refreshUser, isLoading } = useAuth();
  const { t, lang, setLang } = useI18n();

  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  if (isLoading || !user) {
    return (
      <Screen contentStyle={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
      </Screen>
    );
  }

  const stats = user.stats;

  return (
    <Screen contentStyle={styles.screen}>
      {/* Avatar block */}
      <View style={styles.avatarBlock}>
        <Avatar name={user.name} size={80} />
        <Text style={styles.userName}>{user.name}</Text>
        {user.organization ? (
          <Text style={styles.userOrg}>{user.organization}</Text>
        ) : null}
        {user.region ? (
          <Text style={styles.userRegion}>{user.region}</Text>
        ) : null}
      </View>

      {/* Stats row */}
      {stats ? (
        <Card style={styles.statsCard}>
          <StatCell value={stats.fieldCount} label={t('profile.stat.fields')} />
          <StatCell value={stats.totalAreaHa % 1 === 0 ? stats.totalAreaHa : Number(stats.totalAreaHa.toFixed(1))} label={t('profile.stat.ha')} />
          <StatCell value={stats.inspectionCount} label={t('profile.stat.inspections')} />
          <StatCell value={stats.profileCount} label={t('profile.stat.profiles')} />
        </Card>
      ) : null}

      {/* Language selector */}
      <Text style={styles.sectionText}>{t('profile.language')}</Text>
      <Card style={styles.langCard}>
        <LangOption code="ru" label={t('lang.ru')} active={lang === 'ru'} onPress={setLang} />
        <View style={styles.rowDivider} />
        <LangOption code="kk" label={t('lang.kk')} active={lang === 'kk'} onPress={setLang} />
        <View style={styles.rowDivider} />
        <LangOption code="en" label={t('lang.en')} active={lang === 'en'} onPress={setLang} />
      </Card>

      {/* Account info */}
      <Text style={styles.sectionText}>{t('profile.account')}</Text>
      <Card style={styles.infoCard}>
        <InfoRow label={t('profile.email')} value={user.email} />
        <View style={styles.rowDivider} />
        <InfoRow label={t('profile.org')} value={user.organization || '—'} />
        <View style={styles.rowDivider} />
        <InfoRow label={t('profile.region')} value={user.region || '—'} />
        <View style={styles.rowDivider} />
        <InfoRow
          label={t('profile.registered')}
          value={new Date(user.createdAt).toLocaleDateString(lang === 'kk' ? 'kk-KZ' : lang === 'en' ? 'en-US' : 'ru-RU', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })}
        />
      </Card>

      {/* Logout */}
      <Pressable
        onPress={() => void logout()}
        style={({ pressed }) => [styles.logoutButton, pressed && styles.pressed]}
      >
        <Text style={styles.logoutText}>{t('profile.logout')}</Text>
      </Pressable>
    </Screen>
  );
}

function StatCell({ value, label }: { value: string | number; label: string }) {
  return (
    <View style={styles.statCell}>
      <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>{String(value)}</Text>
      <Text style={styles.statLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

function LangOption({
  code,
  label,
  active,
  onPress,
}: {
  code: Lang;
  label: string;
  active: boolean;
  onPress: (next: Lang) => void;
}) {
  return (
    <Pressable
      onPress={() => onPress(code)}
      style={({ pressed }) => [styles.langRow, pressed && styles.pressed]}
    >
      <Text style={[styles.langLabel, active && styles.langLabelActive]}>{label}</Text>
      {active ? <Text style={styles.langCheck}>✓</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 36,
    gap: 12,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Avatar block
  avatarBlock: {
    alignItems: 'center',
    paddingVertical: 12,
    gap: 5,
  },
  userName: {
    fontFamily: fontFamilies.bold,
    fontSize: 20,
    color: colors.text,
    textAlign: 'center',
    marginTop: 10,
  },
  userOrg: {
    fontFamily: fontFamilies.medium,
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  userRegion: {
    fontFamily: fontFamilies.regular,
    fontSize: 13,
    color: colors.muted,
    textAlign: 'center',
  },

  // Stats
  statsCard: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingVertical: 8,
  },
  statCell: {
    width: '50%',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 4,
    paddingVertical: 8,
  },
  statValue: {
    fontFamily: fontFamilies.bold,
    fontSize: 18,
    color: colors.text,
    minWidth: 0,
  },
  statLabel: {
    fontFamily: fontFamilies.medium,
    fontSize: 10,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  // Section label
  sectionText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 11,
    letterSpacing: 0.6,
    color: colors.textSecondary,
    paddingHorizontal: 4,
    textTransform: 'uppercase',
  },

  // Language card
  langCard: {
    padding: 0,
  },
  langRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    minHeight: 50,
  },
  langLabel: {
    fontFamily: fontFamilies.medium,
    fontSize: 15,
    color: colors.text,
  },
  langLabelActive: {
    fontFamily: fontFamilies.semiBold,
    color: colors.primary,
  },
  langCheck: {
    fontFamily: fontFamilies.bold,
    fontSize: 16,
    color: colors.primary,
  },

  // Info card
  infoCard: {
    padding: 0,
  },
  infoRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 5,
    minHeight: 48,
  },
  infoLabel: {
    fontFamily: fontFamilies.regular,
    fontSize: 15,
    color: colors.text,
    width: '100%',
  },
  infoValue: {
    fontFamily: fontFamilies.medium,
    fontSize: 14,
    lineHeight: 19,
    color: colors.textSecondary,
    width: '100%',
    textAlign: 'left',
  },
  rowDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: 16,
  },

  // Logout
  logoutButton: {
    minHeight: 50,
    borderRadius: 10,
    backgroundColor: colors.dangerSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  logoutText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 15,
    color: colors.danger,
  },
  pressed: { opacity: 0.72 },
});
