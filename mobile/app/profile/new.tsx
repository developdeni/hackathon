import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../../src/components/AppText';
import { useRouter } from 'expo-router';

import { Card } from '../../src/components/Card';
import { Screen } from '../../src/components/Screen';
import { createProfile } from '../../src/services/api';
import { colors } from '../../src/theme/colors';
import { fontFamilies } from '../../src/theme/typography';

export default function NewProfileScreen() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [region, setRegion] = useState('Акмолинская область');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (saving) return;
    if (name.trim().length < 2) {
      Alert.alert('Введите название', 'Например: ТОО «Акмола-Агро» или Личное хозяйство.');
      return;
    }
    setSaving(true);
    try {
      const profile = await createProfile({ name: name.trim(), region: region.trim() });
      router.replace({ pathname: '/', params: { profileId: profile.id } });
    } catch (error) {
      Alert.alert('Профиль не сохранён', error instanceof Error ? error.message : 'Повторите попытку.');
      setSaving(false);
    }
  }

  return (
    <Screen contentStyle={styles.content}>
      <View style={styles.titleBlock}>
        <Text style={styles.title}>Новый профиль</Text>
        <Text style={styles.subtitle}>Профиль разделяет поля разных хозяйств, клиентов или учебных сценариев.</Text>
      </View>

      <Card style={styles.formCard}>
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Название профиля</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Например: ТОО «Акмола-Агро»"
            placeholderTextColor={colors.muted}
            style={styles.input}
            returnKeyType="next"
          />
        </View>

        <View style={styles.divider} />

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Регион</Text>
          <TextInput
            value={region}
            onChangeText={setRegion}
            placeholder="Акмолинская область"
            placeholderTextColor={colors.muted}
            style={styles.input}
            returnKeyType="done"
          />
        </View>
      </Card>

      <Pressable
        disabled={saving}
        onPress={save}
        style={({ pressed }) => [styles.primaryButton, (pressed || saving) && styles.buttonPressed]}
      >
        {saving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>Создать профиль</Text>}
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 16,
    gap: 14,
  },
  titleBlock: {
    gap: 4,
  },
  title: {
    fontFamily: fontFamilies.bold,
    fontSize: 20,
    color: colors.text,
  },
  subtitle: {
    fontFamily: fontFamilies.regular,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  formCard: {
    padding: 0,
  },
  fieldGroup: {
    padding: 14,
    gap: 8,
  },
  label: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 12,
    color: colors.textSecondary,
  },
  input: {
    minHeight: 44,
    fontFamily: fontFamilies.medium,
    fontSize: 15,
    color: colors.text,
    padding: 0,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  primaryButton: {
    minHeight: 48,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 15,
    color: '#FFFFFF',
  },
  buttonPressed: {
    opacity: 0.72,
  },
});
