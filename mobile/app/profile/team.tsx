import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Text, TextInput } from '../../src/components/AppText';
import { Card } from '../../src/components/Card';
import { Screen } from '../../src/components/Screen';
import { useI18n } from '../../src/i18n';
import {
  listProfiles,
  listProfileShares,
  listFieldsForProfile,
  inviteToProfile,
  revokeShare,
} from '../../src/services/api';
import { notify } from '../../src/utils/notify';
import type { FarmProfile, Field, ProfileShare, SharePermission } from '../../src/types/domain';
import { colors } from '../../src/theme/colors';
import { fontFamilies } from '../../src/theme/typography';

const ALL_PERMS: SharePermission[] = ['view', 'ai', 'edit', 'inspect'];

export default function TeamScreen() {
  const { t } = useI18n();
  const [ownedProfiles, setOwnedProfiles] = useState<FarmProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [shares, setShares] = useState<ProfileShare[]>([]);
  const [fields, setFields] = useState<Field[]>([]);
  const [loading, setLoading] = useState(true);

  // invite form
  const [granteeId, setGranteeId] = useState('');
  const [perms, setPerms] = useState<Set<SharePermission>>(new Set(['view']));
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);

  const loadProfiles = useCallback(async () => {
    try {
      const list = await listProfiles();
      const owned = list.filter((p) => (p.role ?? 'owner') === 'owner');
      setOwnedProfiles(owned);
      setActiveProfileId((cur) => cur ?? owned[0]?.id ?? null);
    } catch {
      notify(t('team.error'), '');
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadShares = useCallback(async (profileId: string) => {
    try {
      const [s, f] = await Promise.all([
        listProfileShares(profileId),
        listFieldsForProfile(profileId),
      ]);
      setShares(s);
      setFields(f);
    } catch {
      setShares([]);
      setFields([]);
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    if (activeProfileId) void loadShares(activeProfileId);
  }, [activeProfileId, loadShares]);

  function togglePerm(p: SharePermission) {
    setPerms((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      next.add('view'); // просмотр всегда включён
      return next;
    });
  }

  function toggleField(id: string) {
    setSelectedFields((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function sendInvite() {
    if (sending || !activeProfileId) return;
    const id = granteeId.trim().toUpperCase();
    if (id.length < 3) {
      notify(t('team.notFound'), '');
      return;
    }
    if (scope === 'selected' && selectedFields.size === 0) {
      notify(t('team.selectFields'), '');
      return;
    }
    setSending(true);
    try {
      await inviteToProfile(activeProfileId, {
        granteePublicId: id,
        permissions: ALL_PERMS.filter((p) => perms.has(p)),
        fieldScope: scope,
        fieldIds: scope === 'selected' ? Array.from(selectedFields) : [],
      });
      setGranteeId('');
      setSelectedFields(new Set());
      setScope('all');
      setPerms(new Set(['view']));
      notify(t('team.sent'), '');
      await loadShares(activeProfileId);
    } catch (e) {
      notify(t('team.error'), e instanceof Error ? e.message : '');
    } finally {
      setSending(false);
    }
  }

  async function revoke(share: ProfileShare) {
    try {
      await revokeShare(share.id);
      setShares((cur) => cur.filter((s) => s.id !== share.id));
    } catch {
      notify(t('team.error'), '');
    }
  }

  if (loading) {
    return (
      <Screen contentStyle={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
      </Screen>
    );
  }

  if (ownedProfiles.length === 0) {
    return (
      <Screen contentStyle={styles.content}>
        <Text style={styles.title}>{t('team.title')}</Text>
        <Card style={styles.emptyCard}>
          <Text style={styles.emptyText}>{t('team.onlyOwner')}</Text>
        </Card>
      </Screen>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.titleBlock}>
        <Text style={styles.title}>{t('team.title')}</Text>
        <Text style={styles.subtitle}>{t('team.subtitle')}</Text>
      </View>

      {/* Profile selector */}
      {ownedProfiles.length > 1 ? (
        <>
          <Text style={styles.sectionLabel}>{t('team.chooseProfile')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsRow}>
            {ownedProfiles.map((p) => {
              const active = p.id === activeProfileId;
              return (
                <Pressable
                  key={p.id}
                  onPress={() => setActiveProfileId(p.id)}
                  style={[styles.profileChip, active && styles.profileChipActive]}
                >
                  <Text style={[styles.profileChipText, active && styles.profileChipTextActive]}>
                    {p.name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </>
      ) : null}

      {/* Invite form */}
      <Text style={styles.sectionLabel}>{t('team.invite')}</Text>
      <Card style={styles.formCard}>
        <TextInput
          value={granteeId}
          onChangeText={setGranteeId}
          placeholder={t('team.idPlaceholder')}
          placeholderTextColor={colors.muted}
          autoCapitalize="characters"
          style={styles.idInput}
        />

        <Text style={styles.blockLabel}>{t('team.permissions')}</Text>
        {ALL_PERMS.map((p) => (
          <Pressable key={p} onPress={() => togglePerm(p)} style={styles.checkRow}>
            <View style={[styles.checkbox, perms.has(p) && styles.checkboxOn]}>
              {perms.has(p) ? <Text style={styles.checkboxMark}>✓</Text> : null}
            </View>
            <Text style={styles.checkLabel}>{t(`team.perm.${p}`)}</Text>
          </Pressable>
        ))}

        <Text style={styles.blockLabel}>{t('team.scope')}</Text>
        <Pressable onPress={() => setScope('all')} style={styles.checkRow}>
          <View style={[styles.radio, scope === 'all' && styles.radioOn]} />
          <Text style={styles.checkLabel}>{t('team.scope.all')}</Text>
        </Pressable>
        <Pressable onPress={() => setScope('selected')} style={styles.checkRow}>
          <View style={[styles.radio, scope === 'selected' && styles.radioOn]} />
          <Text style={styles.checkLabel}>{t('team.scope.selected')}</Text>
        </Pressable>

        {scope === 'selected' ? (
          <View style={styles.fieldsBox}>
            {fields.length === 0 ? (
              <Text style={styles.dimText}>—</Text>
            ) : (
              fields.map((f) => (
                <Pressable key={f.id} onPress={() => toggleField(f.id)} style={styles.checkRow}>
                  <View style={[styles.checkbox, selectedFields.has(f.id) && styles.checkboxOn]}>
                    {selectedFields.has(f.id) ? <Text style={styles.checkboxMark}>✓</Text> : null}
                  </View>
                  <Text style={styles.checkLabel}>{f.name} · {f.cropType}</Text>
                </Pressable>
              ))
            )}
          </View>
        ) : null}

        <Pressable
          disabled={sending}
          onPress={() => void sendInvite()}
          style={({ pressed }) => [styles.sendButton, (pressed || sending) && styles.pressed]}
        >
          {sending ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.sendButtonText}>{t('team.send')}</Text>
          )}
        </Pressable>
      </Card>

      {/* Members / invitations */}
      <Text style={styles.sectionLabel}>{t('team.members')}</Text>
      {shares.length === 0 ? (
        <Card style={styles.emptyCard}>
          <Text style={styles.emptyText}>{t('team.empty')}</Text>
        </Card>
      ) : (
        shares.map((s) => (
          <Card key={s.id} style={styles.memberCard}>
            <View style={styles.memberHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.memberName}>{s.granteeName || s.granteePublicId}</Text>
                <Text style={styles.memberMeta}>
                  {s.granteePublicId}
                  {' · '}
                  <Text style={s.status === 'active' ? styles.statusActive : styles.statusPending}>
                    {s.status === 'active' ? t('team.statusActive') : t('team.statusPending')}
                  </Text>
                </Text>
              </View>
              <Pressable
                onPress={() => void revoke(s)}
                style={({ pressed }) => [styles.revokeButton, pressed && styles.pressed]}
              >
                <Text style={styles.revokeText}>{t('team.revoke')}</Text>
              </Pressable>
            </View>
            <View style={styles.memberPerms}>
              {s.permissions.filter((p) => p !== 'view').map((p) => (
                <View key={p} style={styles.permChip}>
                  <Text style={styles.permChipText}>{t(`team.perm.${p}`)}</Text>
                </View>
              ))}
              <View style={styles.scopeChip}>
                <Text style={styles.scopeChipText}>
                  {s.fieldScope === 'all' ? t('invite.wholeProfile') : t('invite.selectedFields')}
                </Text>
              </View>
            </View>
          </Card>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingVertical: 12, gap: 8, paddingBottom: 40 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  titleBlock: { gap: 4, marginBottom: 4 },
  title: { fontFamily: fontFamilies.bold, fontSize: 22, color: colors.text },
  subtitle: { fontFamily: fontFamilies.regular, fontSize: 13, color: colors.textSecondary },
  sectionLabel: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 12,
    marginLeft: 4,
  },
  chipsRow: { flexDirection: 'row' },
  profileChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.surface,
    marginRight: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  profileChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  profileChipText: { fontFamily: fontFamilies.medium, fontSize: 13, color: colors.text },
  profileChipTextActive: { color: '#FFFFFF' },
  formCard: { padding: 14, gap: 10 },
  idInput: {
    minHeight: 46,
    borderRadius: 10,
    backgroundColor: colors.surfaceSecondary,
    paddingHorizontal: 12,
    fontFamily: fontFamilies.semiBold,
    fontSize: 16,
    letterSpacing: 1,
    color: colors.text,
  },
  blockLabel: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 11.5,
    color: colors.textSecondary,
    marginTop: 6,
  },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkboxMark: { color: '#FFFFFF', fontSize: 14, fontFamily: fontFamilies.bold },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  radioOn: { borderColor: colors.primary, borderWidth: 7 },
  checkLabel: { flex: 1, fontFamily: fontFamilies.medium, fontSize: 14, color: colors.text },
  fieldsBox: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: 4,
    marginTop: 2,
  },
  dimText: { fontFamily: fontFamilies.regular, fontSize: 13, color: colors.muted, padding: 8 },
  sendButton: {
    minHeight: 48,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  sendButtonText: { fontFamily: fontFamilies.semiBold, fontSize: 15, color: '#FFFFFF' },
  pressed: { opacity: 0.72 },
  emptyCard: { padding: 16, alignItems: 'center' },
  emptyText: { fontFamily: fontFamilies.regular, fontSize: 13.5, color: colors.textSecondary, textAlign: 'center' },
  memberCard: { padding: 14, gap: 10, marginBottom: 8 },
  memberHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  memberName: { fontFamily: fontFamilies.semiBold, fontSize: 15, color: colors.text },
  memberMeta: { fontFamily: fontFamilies.regular, fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  statusActive: { color: colors.success, fontFamily: fontFamilies.semiBold },
  statusPending: { color: colors.warning, fontFamily: fontFamilies.semiBold },
  revokeButton: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: colors.dangerSoft,
  },
  revokeText: { fontFamily: fontFamilies.semiBold, fontSize: 12.5, color: colors.danger },
  memberPerms: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  permChip: { backgroundColor: colors.surfaceSecondary, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  permChipText: { fontFamily: fontFamilies.medium, fontSize: 11, color: colors.textSecondary },
  scopeChip: { backgroundColor: colors.infoSoft, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  scopeChipText: { fontFamily: fontFamilies.medium, fontSize: 11, color: colors.info },
});
