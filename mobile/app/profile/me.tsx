import { useEffect } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../../src/components/AppText';
import { Avatar } from '../../src/components/Avatar';
import { Card } from '../../src/components/Card';
import { Screen } from '../../src/components/Screen';
import { useAuth } from '../../src/contexts/AuthContext';
import { colors } from '../../src/theme/colors';
import { fontFamilies } from '../../src/theme/typography';

export default function MyProfileScreen() {
  const { user, logout, refreshUser, isLoading } = useAuth();

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
          <StatCell value={stats.fieldCount} label="участков" />
          <StatCell value={stats.totalAreaHa % 1 === 0 ? stats.totalAreaHa : Number(stats.totalAreaHa.toFixed(1))} label="га" />
          <StatCell value={stats.inspectionCount} label="осмотров" />
          <StatCell value={stats.profileCount} label="профилей" />
        </Card>
      ) : null}

      {/* Account info */}
      <Text style={styles.sectionText}>АККАУНТ</Text>
      <Card style={styles.infoCard}>
        <InfoRow label="Email" value={user.email} />
        <View style={styles.rowDivider} />
        <InfoRow label="Организация" value={user.organization || '—'} />
        <View style={styles.rowDivider} />
        <InfoRow label="Регион" value={user.region || '—'} />
        <View style={styles.rowDivider} />
        <InfoRow
          label="Дата регистрации"
          value={new Date(user.createdAt).toLocaleDateString('ru-RU', {
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
        <Text style={styles.logoutText}>Выйти из аккаунта</Text>
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
