import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { Text, TextInput } from '../../src/components/AppText';
import { Card } from '../../src/components/Card';
import { Screen } from '../../src/components/Screen';
import { useAuth } from '../../src/contexts/AuthContext';
import { useI18n } from '../../src/i18n';
import { updateProfile, requestEmailCode, confirmEmailCode } from '../../src/services/api';
import { notify } from '../../src/utils/notify';
import { colors } from '../../src/theme/colors';
import { fontFamilies } from '../../src/theme/typography';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type EmailStep = 'idle' | 'input' | 'code';

export default function EditProfileScreen() {
  const router = useRouter();
  const { user, applyUser } = useAuth();
  const { t } = useI18n();

  const [name, setName] = useState(user?.name ?? '');
  const [organization, setOrganization] = useState(user?.organization ?? '');
  const [region, setRegion] = useState(user?.region ?? '');
  const [savingInfo, setSavingInfo] = useState(false);

  const [emailStep, setEmailStep] = useState<EmailStep>('idle');
  const [newEmail, setNewEmail] = useState('');
  const [sendingCode, setSendingCode] = useState(false);
  const [code, setCode] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);

  async function saveInfo() {
    if (savingInfo) return;
    if (name.trim().length < 2) {
      notify(t('edit.error'), t('edit.namePlaceholder'));
      return;
    }
    setSavingInfo(true);
    try {
      const updated = await updateProfile({
        name: name.trim(),
        organization: organization.trim(),
        region: region.trim(),
      });
      await applyUser(updated);
      notify(t('edit.saved'), '');
      router.back();
    } catch (error) {
      notify(t('edit.error'), error instanceof Error ? error.message : '');
    } finally {
      setSavingInfo(false);
    }
  }

  function startEmailChange(prefill: string) {
    setNewEmail(prefill);
    setCode('');
    setDevCode(null);
    setEmailStep('input');
  }

  async function sendCode() {
    if (sendingCode) return;
    const target = newEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(target)) {
      notify(t('edit.invalidEmail'), '');
      return;
    }
    setSendingCode(true);
    try {
      const res = await requestEmailCode(target);
      setDevCode(res.devCode ?? null);
      setEmailStep('code');
      if (!res.devCode) {
        notify(`${t('edit.codeSentTo')} ${res.target}`, '');
      }
    } catch (error) {
      notify(t('edit.error'), error instanceof Error ? error.message : '');
    } finally {
      setSendingCode(false);
    }
  }

  async function confirmCode() {
    if (confirming) return;
    if (code.trim().length < 4) {
      notify(t('edit.codeError'), '');
      return;
    }
    setConfirming(true);
    try {
      const updated = await confirmEmailCode(code.trim());
      await applyUser(updated);
      setEmailStep('idle');
      setCode('');
      setDevCode(null);
      notify(t('edit.emailConfirmed'), '');
    } catch (error) {
      notify(t('edit.codeError'), error instanceof Error ? error.message : '');
    } finally {
      setConfirming(false);
    }
  }

  if (!user) {
    return (
      <Screen contentStyle={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
      </Screen>
    );
  }

  return (
    <Screen contentStyle={styles.content}>
      <View style={styles.titleBlock}>
        <Text style={styles.title}>{t('edit.title')}</Text>
      </View>

      {/* Personal data */}
      <Text style={styles.sectionLabel}>{t('edit.section.info')}</Text>
      <Card style={styles.formCard}>
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>{t('edit.name')}</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={t('edit.namePlaceholder')}
            placeholderTextColor={colors.muted}
            style={styles.input}
            returnKeyType="next"
          />
        </View>
        <View style={styles.divider} />
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>{t('edit.org')}</Text>
          <TextInput
            value={organization}
            onChangeText={setOrganization}
            placeholder={t('edit.orgPlaceholder')}
            placeholderTextColor={colors.muted}
            style={styles.input}
            returnKeyType="next"
          />
        </View>
        <View style={styles.divider} />
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>{t('edit.region')}</Text>
          <TextInput
            value={region}
            onChangeText={setRegion}
            placeholder={t('edit.regionPlaceholder')}
            placeholderTextColor={colors.muted}
            style={styles.input}
            returnKeyType="done"
          />
        </View>
      </Card>

      <Pressable
        disabled={savingInfo}
        onPress={saveInfo}
        style={({ pressed }) => [styles.primaryButton, (pressed || savingInfo) && styles.buttonPressed]}
      >
        {savingInfo ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text style={styles.primaryButtonText}>{t('edit.save')}</Text>
        )}
      </Pressable>

      {/* Email */}
      <Text style={styles.sectionLabel}>{t('edit.section.email')}</Text>
      <Card style={styles.formCard}>
        <View style={styles.emailHeaderRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.emailValue}>{user.email}</Text>
            <View
              style={[
                styles.badge,
                user.emailVerified ? styles.badgeOk : styles.badgeWarn,
              ]}
            >
              <Text
                style={[
                  styles.badgeText,
                  user.emailVerified ? styles.badgeTextOk : styles.badgeTextWarn,
                ]}
              >
                {user.emailVerified ? `✓ ${t('profile.emailVerified')}` : t('profile.emailUnverified')}
              </Text>
            </View>
          </View>
        </View>

        {emailStep === 'idle' && (
          <View style={styles.emailActionsRow}>
            {!user.emailVerified && (
              <Pressable
                onPress={() => startEmailChange(user.email)}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
              >
                <Text style={styles.secondaryButtonText}>{t('edit.verifyEmail')}</Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => startEmailChange('')}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
            >
              <Text style={styles.secondaryButtonText}>{t('edit.changeEmail')}</Text>
            </Pressable>
          </View>
        )}

        {emailStep === 'input' && (
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>{t('edit.newEmail')}</Text>
            <TextInput
              value={newEmail}
              onChangeText={setNewEmail}
              placeholder="you@example.kz"
              placeholderTextColor={colors.muted}
              style={styles.input}
              autoCapitalize="none"
              keyboardType="email-address"
              returnKeyType="send"
              onSubmitEditing={() => void sendCode()}
            />
            <Text style={styles.note}>{t('edit.emailNote')}</Text>
            <View style={styles.emailActionsRow}>
              <Pressable
                onPress={() => setEmailStep('idle')}
                style={({ pressed }) => [styles.ghostButton, pressed && styles.buttonPressed]}
              >
                <Text style={styles.ghostButtonText}>{t('edit.cancel')}</Text>
              </Pressable>
              <Pressable
                disabled={sendingCode}
                onPress={() => void sendCode()}
                style={({ pressed }) => [styles.primaryButtonSm, (pressed || sendingCode) && styles.buttonPressed]}
              >
                {sendingCode ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.primaryButtonText}>{t('edit.sendCode')}</Text>
                )}
              </Pressable>
            </View>
          </View>
        )}

        {emailStep === 'code' && (
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>{t('edit.enterCode')}</Text>
            <Text style={styles.codeTarget}>{`${t('edit.codeSentTo')} ${newEmail.trim().toLowerCase()}`}</Text>
            <TextInput
              value={code}
              onChangeText={setCode}
              placeholder="______"
              placeholderTextColor={colors.muted}
              style={[styles.input, styles.codeInput]}
              keyboardType="number-pad"
              maxLength={6}
              returnKeyType="done"
              onSubmitEditing={() => void confirmCode()}
            />
            {devCode ? (
              <Text style={styles.devCode}>{`${t('edit.devCodeNote')} ${devCode}`}</Text>
            ) : null}
            <View style={styles.emailActionsRow}>
              <Pressable
                onPress={() => setEmailStep('input')}
                style={({ pressed }) => [styles.ghostButton, pressed && styles.buttonPressed]}
              >
                <Text style={styles.ghostButtonText}>{t('edit.cancel')}</Text>
              </Pressable>
              <Pressable
                disabled={confirming}
                onPress={() => void confirmCode()}
                style={({ pressed }) => [styles.primaryButtonSm, (pressed || confirming) && styles.buttonPressed]}
              >
                {confirming ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.primaryButtonText}>{t('edit.confirm')}</Text>
                )}
              </Pressable>
            </View>
          </View>
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, gap: 10, paddingBottom: 32 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  titleBlock: { gap: 4, marginBottom: 2 },
  title: { fontFamily: fontFamilies.bold, fontSize: 22, color: colors.text },
  sectionLabel: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 10,
    marginLeft: 4,
  },
  formCard: { padding: 0 },
  fieldGroup: { padding: 14, gap: 8 },
  label: { fontFamily: fontFamilies.semiBold, fontSize: 12, color: colors.textSecondary },
  input: {
    minHeight: 44,
    fontFamily: fontFamilies.medium,
    fontSize: 15,
    color: colors.text,
    padding: 0,
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  note: { fontFamily: fontFamilies.regular, fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  primaryButton: {
    minHeight: 48,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonSm: {
    minHeight: 42,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: { fontFamily: fontFamilies.semiBold, fontSize: 15, color: '#FFFFFF' },
  buttonPressed: { opacity: 0.72 },
  emailHeaderRow: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 10 },
  emailValue: { fontFamily: fontFamilies.semiBold, fontSize: 15, color: colors.text, marginBottom: 6 },
  badge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeOk: { backgroundColor: colors.successSoft },
  badgeWarn: { backgroundColor: colors.warningSoft },
  badgeText: { fontFamily: fontFamilies.semiBold, fontSize: 11 },
  badgeTextOk: { color: colors.success },
  badgeTextWarn: { color: colors.warning },
  emailActionsRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 14,
    paddingBottom: 14,
    alignItems: 'center',
  },
  secondaryButton: {
    flex: 1,
    minHeight: 42,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: { fontFamily: fontFamilies.semiBold, fontSize: 14, color: colors.primary },
  ghostButton: {
    minHeight: 42,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghostButtonText: { fontFamily: fontFamilies.medium, fontSize: 14, color: colors.textSecondary },
  codeTarget: { fontFamily: fontFamilies.regular, fontSize: 12, color: colors.textSecondary },
  codeInput: { fontSize: 24, letterSpacing: 8, fontFamily: fontFamilies.bold },
  devCode: { fontFamily: fontFamilies.medium, fontSize: 12, color: colors.info },
});
