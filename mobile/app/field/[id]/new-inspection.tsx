import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  ImageStyle,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';

import { Card } from '../../../src/components/Card';
import { Screen } from '../../../src/components/Screen';
import { createInspection } from '../../../src/services/api';
import { colors } from '../../../src/theme/colors';
import { fontFamilies, typography } from '../../../src/theme/typography';

type Coordinates = { latitude: number; longitude: number };

export default function NewInspectionScreen() {
  const { id: fieldId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [note, setNote] = useState('');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [coordinates, setCoordinates] = useState<Coordinates | null>(null);
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    ImagePicker.getPendingResultAsync().then((result) => {
      if (result && 'canceled' in result && !result.canceled && result.assets[0]) {
        setPhotoUri(result.assets[0].uri);
      }
    });
  }, []);

  async function takePhoto() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Доступ ограничен', 'Разрешите доступ к камере в настройках устройства.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.85 });
    if (!result.canceled && result.assets[0]) {
      setPhotoUri(result.assets[0].uri);
    }
  }

  async function pickPhoto() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Доступ ограничен', 'Разрешите доступ к фото в настройках устройства.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.85 });
    if (!result.canceled && result.assets[0]) {
      setPhotoUri(result.assets[0].uri);
    }
  }

  async function addLocation() {
    setLocating(true);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Геопозиция не получена', 'Осмотр можно сохранить без координат.');
        return;
      }
      const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setCoordinates({ latitude: location.coords.latitude, longitude: location.coords.longitude });
    } catch {
      Alert.alert('Ошибка геопозиции', 'Не удалось определить текущие координаты.');
    } finally {
      setLocating(false);
    }
  }

  async function save() {
    if (!fieldId || saving) return;
    if (!note.trim() && !photoUri) {
      Alert.alert('Требуются данные', 'Прикрепите фотографию или введите заметку осмотра.');
      return;
    }
    setSaving(true);
    try {
      const inspection = await createInspection({
        fieldId,
        note: note.trim(),
        photoUri,
        latitude: coordinates?.latitude ?? null,
        longitude: coordinates?.longitude ?? null,
      });
      router.replace({ pathname: '/inspection/[id]', params: { id: inspection.id } });
    } catch (error) {
      Alert.alert('Ошибка сохранения', error instanceof Error ? error.message : 'Повторите попытку.');
      setSaving(false);
    }
  }

  return (
    <Screen contentStyle={styles.content}>
      {/* Screen Title */}
      <View style={styles.titleBox}>
        <Text style={styles.screenTitle}>Новый осмотр участка</Text>
        <Text style={styles.screenSubtitle}>Поле ID: {fieldId}</Text>
      </View>

      {/* Photo Attachment Section */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>ФОТОФИКСАЦИЯ</Text>
        {photoUri ? (
          <Card style={styles.photoPreviewCard}>
            <Image source={{ uri: photoUri }} style={styles.photoPreview as ImageStyle} />
            <Pressable onPress={() => setPhotoUri(null)} style={styles.removePhotoButton}>
              <Text style={styles.removePhotoText}>Удалить прикреплённый снимок</Text>
            </Pressable>
          </Card>
        ) : (
          <Card style={styles.photoControlCard}>
            <Text style={styles.photoHint}>Снимок общего плана или отдельного растения</Text>
            <View style={styles.photoButtonsRow}>
              <Pressable onPress={takePhoto} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>Сделать снимок (Камера)</Text>
              </Pressable>
              <Pressable onPress={pickPhoto} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>Выбрать из медиатеки</Text>
              </Pressable>
            </View>
          </Card>
        )}
      </View>

      {/* Note Section */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>ЗАМЕТКА АГРОНОМА</Text>
        <Card style={styles.inputCard}>
          <TextInput
            multiline
            value={note}
            onChangeText={setNote}
            placeholder="Фаза вегетации, влажность почвы, признаки поражения или сорняков…"
            placeholderTextColor={colors.muted}
            style={styles.textInput}
            textAlignVertical="top"
          />
        </Card>
      </View>

      {/* Geolocation Section */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>GPS-КООРДИНАТЫ</Text>
        <Card style={styles.locationCard}>
          <View style={styles.locationRow}>
            <View style={styles.locationInfo}>
              <Text style={styles.locationTitle}>
                {coordinates ? 'Точка зафиксирована' : 'Координаты не указаны'}
              </Text>
              <Text style={styles.locationSubtitle}>
                {coordinates
                  ? `${coordinates.latitude.toFixed(6)}, ${coordinates.longitude.toFixed(6)}`
                  : 'Определение по системному датчику устройства'}
              </Text>
            </View>

            <Pressable
              disabled={locating}
              onPress={addLocation}
              style={[styles.smallButton, locating && styles.buttonDisabled]}
            >
              {locating ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Text style={styles.smallButtonText}>
                  {coordinates ? 'Обновить' : 'Определить'}
                </Text>
              )}
            </Pressable>
          </View>
        </Card>
      </View>

      {/* Technical Status Callout */}
      <View style={styles.technicalBox}>
        <Text style={styles.technicalText}>
          Сохранение выполняется в локальную базу SQLite на ноутбуке. AI-анализ на данном этапе не применяется.
        </Text>
      </View>

      {/* Primary Submit Button */}
      <Pressable
        disabled={saving}
        onPress={save}
        style={({ pressed }) => [styles.submitButton, (pressed || saving) && styles.buttonDisabled]}
      >
        {saving ? (
          <ActivityIndicator size="small" color="#FFFFFF" />
        ) : (
          <Text style={styles.submitButtonText}>Зафиксировать и отправить</Text>
        )}
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 36,
    gap: 14,
  },
  titleBox: {
    gap: 2,
    paddingHorizontal: 2,
  },
  screenTitle: {
    ...typography.screenTitle,
    color: colors.text,
  },
  screenSubtitle: {
    ...typography.metaMono,
    color: colors.muted,
  },

  section: {
    gap: 6,
  },
  sectionLabel: {
    ...typography.sectionHeader,
    color: colors.textSecondary,
    paddingHorizontal: 4,
  },

  // Photo Cards
  photoControlCard: {
    padding: 12,
    gap: 10,
  },
  photoHint: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  photoButtonsRow: {
    gap: 8,
  },
  secondaryButton: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    fontFamily: fontFamilies.medium,
    fontSize: 13.5,
    color: colors.text,
  },
  photoPreviewCard: {
    padding: 0,
    overflow: 'hidden',
  },
  photoPreview: {
    width: '100%',
    height: 220,
    resizeMode: 'cover',
  },
  removePhotoButton: {
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  removePhotoText: {
    fontFamily: fontFamilies.medium,
    fontSize: 13,
    color: colors.danger,
  },

  // Note Input Card
  inputCard: {
    padding: 12,
  },
  textInput: {
    fontFamily: fontFamilies.regular,
    fontSize: 14.5,
    color: colors.text,
    minHeight: 85,
    lineHeight: 20,
  },

  // Location Card
  locationCard: {
    padding: 12,
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  locationInfo: {
    flex: 1,
    gap: 2,
  },
  locationTitle: {
    ...typography.headline,
    fontSize: 14,
    color: colors.text,
  },
  locationSubtitle: {
    ...typography.caption,
    color: colors.muted,
  },
  smallButton: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 6,
  },
  smallButtonText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 12,
    color: colors.primary,
  },

  // Technical Box
  technicalBox: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 10,
  },
  technicalText: {
    ...typography.caption,
    color: colors.textSecondary,
    lineHeight: 16,
  },

  // Submit Button
  submitButton: {
    backgroundColor: colors.primary,
    height: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  buttonDisabled: {
    opacity: 0.75,
  },
  submitButtonText: {
    ...typography.button,
    color: '#FFFFFF',
  },
});
