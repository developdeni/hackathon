import { useState, useEffect } from 'react';
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
  const { login, loginWithTelegram } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Telegram WebApp detection
  const [tgUser, setTgUser] = useState<any>(null);
  const [tgName, setTgName] = useState('');
  const [companyName, setCompanyName] = useState('КХ Алтын Дән');
  const [showEmailForm, setShowEmailForm] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const tg = (window as any).Telegram?.WebApp;
      if (tg) {
        tg.ready?.();
        tg.expand?.();
        const user = tg.initDataUnsafe?.user;
        if (user) {
          setTgUser(user);
          const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ');
          setTgName(fullName || user.username || 'Агроном');
        }
      }
    }
  }, []);

  async function handleTelegramLogin() {
    if (!tgUser) return;
    const finalName = tgName.trim();
    const finalCompany = companyName.trim();
    if (!finalName) { setError('Введите ваше имя'); return; }
    if (!finalCompany) { setError('Введите название хозяйства (КХ / ТОО)'); return; }

    setError(null);
    setLoading(true);
    try {
      if (typeof window !== 'undefined' && (window as any).Telegram?.WebApp?.HapticFeedback) {
        (window as any).Telegram.WebApp.HapticFeedback.notificationOccurred('success');
      }
      await loginWithTelegram({
        telegramId: tgUser.id,
        name: finalName,
        companyName: finalCompany,
        username: tgUser.username,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось войти через Telegram');
    } finally {
      setLoading(false);
    }
  }

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

        {/* Telegram 1-Click Auth Card if in Telegram */}
        {tgUser ? (
          <View style={styles.tgCard}>
            <View style={styles.tgBadgeRow}>
              <View style={styles.tgBadge}>
                <Text style={styles.tgBadgeText}>🌾 Telegram Mini App</Text>
              </View>
            </View>
            <Text style={styles.tgTitle}>
              Добро пожаловать, {tgUser.first_name || 'Агроном'}!
            </Text>
            <Text style={styles.tgSub}>
              Подтвердите ваше имя и введите название хозяйства для мгновенного входа:
            </Text>

            <InputField
              label="Ваше имя / ФИО"
              value={tgName}
              onChangeText={setTgName}
              placeholder="Данил Мирошниченко"
            />
            <InputField
              label="Название хозяйства (КХ / ТОО)"
              value={companyName}
              onChangeText={setCompanyName}
              placeholder="КХ Алтын Дән"
            />

            {error ? <Text style={styles.errorBanner}>{error}</Text> : null}

            <Pressable
              onPress={() => void handleTelegramLogin()}
              disabled={loading}
              style={({ pressed }) => [styles.loginButton, (pressed || loading) && styles.buttonPressed]}
            >
              <Text style={styles.loginButtonText}>
                {loading ? 'Вход…' : '🌾 Войти в Tanap AI'}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => setShowEmailForm(!showEmailForm)}
              style={styles.tgToggleBtn}
            >
              <Text style={styles.tgToggleText}>
                {showEmailForm ? 'Скрыть вход по паролю' : 'Или войти по email и паролю'}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {/* Standard Email/Password Form (Always shown on native, togglable or fallback on web) */}
        {(!tgUser || showEmailForm) && (
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

            {error && !tgUser ? <Text style={styles.errorBanner}>{error}</Text> : null}

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
        )}

        {/* Footer */}
        {!tgUser && (
          <View style={styles.footer}>
            <Text style={styles.footerText}>Нет аккаунта? </Text>
            <Pressable onPress={() => router.push('/auth/register')}>
              <Text style={styles.footerLink}>Создать</Text>
            </Pressable>
          </View>
        )}
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
  tgCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 3,
  },
  tgBadgeRow: {
    flexDirection: 'row',
  },
  tgBadge: {
    backgroundColor: '#E8F5E9',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  tgBadgeText: {
    color: colors.primary,
    fontFamily: fontFamilies.semiBold,
    fontSize: 12,
  },
  tgTitle: {
    fontFamily: fontFamilies.bold,
    fontSize: 18,
    color: colors.text,
  },
  tgSub: {
    fontFamily: fontFamilies.regular,
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  tgToggleBtn: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  tgToggleText: {
    fontFamily: fontFamilies.medium,
    fontSize: 13,
    color: colors.textSecondary,
  },
});
