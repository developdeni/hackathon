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

export default function LoginScreen() {
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) { setError('Введите email'); return; }
    if (!password) { setError('Введите пароль'); return; }
    setError(null);
    setLoading(true);
    try {
      await login({ email: trimmedEmail, password });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось войти');
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
        {/* Logo */}
        <View style={styles.logoBlock}>
          <Text style={styles.logoText}>Tanap AI</Text>
          <Text style={styles.logoSub}>Мобильный терминал агронома</Text>
        </View>

        {/* Form */}
        <View style={styles.form}>
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
            placeholder="••••••••"
          />

          {error ? <Text style={styles.errorBanner}>{error}</Text> : null}

          <Pressable
            onPress={() => void handleLogin()}
            disabled={loading}
            style={({ pressed }) => [styles.loginButton, (pressed || loading) && styles.buttonPressed]}
          >
            <Text style={styles.loginButtonText}>
              {loading ? 'Вход…' : 'Войти'}
            </Text>
          </Pressable>
        </View>

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>Нет аккаунта? </Text>
          <Pressable onPress={() => router.push('/auth/register')}>
            <Text style={styles.footerLink}>Создать</Text>
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
    gap: 32,
  },
  logoBlock: {
    alignItems: 'center',
    gap: 6,
  },
  logoText: {
    fontFamily: fontFamilies.bold,
    fontSize: 32,
    color: colors.primary,
    letterSpacing: -0.5,
  },
  logoSub: {
    fontFamily: fontFamilies.medium,
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  form: {
    gap: 14,
  },
  errorBanner: {
    fontFamily: fontFamilies.medium,
    fontSize: 13,
    color: colors.danger,
    backgroundColor: colors.dangerSoft,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  loginButton: {
    minHeight: 50,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  loginButtonText: {
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
