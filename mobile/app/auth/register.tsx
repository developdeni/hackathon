import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Text } from '../../src/components/AppText';
import { useRouter } from 'expo-router';
import { useAuth } from '../../src/contexts/AuthContext';
import { InputField } from '../../src/components/InputField';
import { colors } from '../../src/theme/colors';
import { fontFamilies } from '../../src/theme/typography';

export default function RegisterScreen() {
  const router = useRouter();
  const { register } = useAuth();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organization, setOrganization] = useState('');
  const [region, setRegion] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleRegister() {
    const trimName = name.trim();
    const trimEmail = email.trim().toLowerCase();
    if (trimName.length < 2) { setError('Введите имя (минимум 2 символа)'); return; }
    if (!trimEmail.includes('@')) { setError('Введите корректный email'); return; }
    if (password.length < 6) { setError('Пароль минимум 6 символов'); return; }
    setError(null);
    setLoading(true);
    try {
      await register({
        name: trimName,
        email: trimEmail,
        password,
        organization: organization.trim(),
        region: region.trim(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать аккаунт');
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.logoBlock}>
          <Text style={styles.logoText}>Tanap AI</Text>
          <Text style={styles.logoSub}>Создание аккаунта</Text>
        </View>

        <View style={styles.form}>
          <InputField
            label="Имя"
            value={name}
            onChangeText={setName}
            autoComplete="name"
            placeholder="Иван Петров"
            autoCapitalize="words"
          />
          <InputField
            label="Email"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoComplete="email"
            placeholder="agro@example.com"
          />
          <InputField
            label="Пароль"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="Минимум 6 символов"
          />
          <InputField
            label="Организация (необязательно)"
            value={organization}
            onChangeText={setOrganization}
            placeholder="ТОО «Акмола-Агро»"
            autoCapitalize="sentences"
          />
          <InputField
            label="Регион (необязательно)"
            value={region}
            onChangeText={setRegion}
            placeholder="Акмолинская область"
            autoCapitalize="sentences"
          />

          {error ? <Text style={styles.errorBanner}>{error}</Text> : null}

          <Pressable
            onPress={() => void handleRegister()}
            disabled={loading}
            style={({ pressed }) => [styles.registerButton, (pressed || loading) && styles.buttonPressed]}
          >
            <Text style={styles.registerButtonText}>
              {loading ? 'Создание…' : 'Создать аккаунт'}
            </Text>
          </Pressable>
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>Есть аккаунт? </Text>
          <Pressable onPress={() => router.back()}>
            <Text style={styles.footerLink}>Войти</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 48,
    gap: 28,
  },
  logoBlock: {
    alignItems: 'center',
    gap: 6,
  },
  logoText: {
    fontFamily: fontFamilies.bold,
    fontSize: 28,
    color: colors.primary,
    letterSpacing: -0.5,
  },
  logoSub: {
    fontFamily: fontFamilies.medium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  form: { gap: 12 },
  errorBanner: {
    fontFamily: fontFamilies.medium,
    fontSize: 13,
    color: colors.danger,
    backgroundColor: colors.dangerSoft,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  registerButton: {
    minHeight: 50,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  registerButtonText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 15,
    color: '#FFFFFF',
  },
  buttonPressed: { opacity: 0.72 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  footerText: {
    fontFamily: fontFamilies.regular,
    fontSize: 14,
    color: colors.textSecondary,
  },
  footerLink: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 14,
    color: colors.primary,
  },
});
