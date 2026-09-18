import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  ImageStyle,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { Text, TextInput } from '../../../src/components/AppText';
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
  const { id: fieldId, targetLat, targetLng, zoneTitle } = useLocalSearchParams<{
    id: string;
    targetLat?: string;
    targetLng?: string;
    zoneTitle?: string;
  }>();
  const router = useRouter();
  const [note, setNote] = useState('');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [coordinates, setCoordinates] = useState<Coordinates | null>(null);
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (targetLat && targetLng) {
      const lat = parseFloat(targetLat);
      const lng = parseFloat(targetLng);
      if (!isNaN(lat) && !isNaN(lng)) {
        setCoordinates({ latitude: lat, longitude: lng });
        if (zoneTitle) {
          setNote(`[Проверка спутникового очага: ${zoneTitle}]\n`);
        }
      }
    }
  }, [targetLat, targetLng, zoneTitle]);

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

      {/* Status Note */}
      <View style={styles.noteBox}>
        <Text style={styles.noteText}>
          Акт осмотра сохраняется в постоянный журнал хозяйства и привязывается к координатам поля.
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
          <Text style={styles.submitButtonText}>Сохранить акт осмотра</Text>
        )}
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 36,
    gap: 12,
  },
  titleBox: {
    gap: 2,
    paddingHorizontal: 2,
  },
  screenTitle: {
    fontFamily: fontFamilies.bold,
    fontSize: 18,
    color: colors.text,
  },
  screenSubtitle: {
    fontFamily: fontFamilies.regular,
    fontSize: 12.5,
    color: colors.textSecondary,
  },

  section: {
    gap: 6,
  },
  sectionLabel: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 11.5,
    letterSpacing: 0.5,
    color: colors.textSecondary,
    paddingHorizontal: 4,
  },

  // Photo Cards
  photoControlCard: {
    padding: 14,
    gap: 10,
  },
  photoHint: {
    fontFamily: fontFamilies.regular,
    fontSize: 12.5,
    color: colors.textSecondary,
  },
  photoButtonsRow: {
    gap: 8,
  },
  secondaryButton: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    fontFamily: fontFamilies.semiBold,
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
    fontSize: 14,
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
    fontFamily: fontFamilies.semiBold,
    fontSize: 14,
    color: colors.text,
  },
  locationSubtitle: {
    fontFamily: fontFamilies.regular,
    fontSize: 12,
    color: colors.muted,
  },
  smallButton: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
  },
  smallButtonText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 12,
    color: colors.primary,
  },

  // Note Box
  noteBox: {
    paddingHorizontal: 4,
  },
  noteText: {
    fontFamily: fontFamilies.regular,
    fontSize: 11.5,
    color: colors.muted,
    lineHeight: 16,
  },

  // Submit Button
  submitButton: {
    backgroundColor: colors.primary,
    height: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  buttonDisabled: {
    opacity: 0.75,
  },
  submitButtonText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 14,
    color: '#FFFFFF',
  },
});
