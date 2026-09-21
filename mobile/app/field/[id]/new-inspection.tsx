import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  ImageStyle,
  Linking,
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
import {
  cancelNativeOrWebRecording,
  checkMicrophonePermission,
  startNativeOrWebRecording,
  stopNativeOrWebRecording,
} from '../../../src/services/voice-recorder';
import { createInspection, summarizeVoiceInspection } from '../../../src/services/api';
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
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [coordinates, setCoordinates] = useState<Coordinates | null>(null);
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);

  // Voice recording state
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const timerRef = useRef<any>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      cancelNativeOrWebRecording().catch(() => {});
    };
  }, []);

  async function startVoiceRecording() {
    if (recording || transcribing) return;
    try {
      const perm = await checkMicrophonePermission();
      if (!perm.granted) {
        Alert.alert(
          'Доступ к микрофону',
          'Для записи голосового осмотра Tanap AI требуется доступ к микрофону.\n\nРазрешите доступ в Настройках iOS.',
          [
            { text: 'Отмена', style: 'cancel' },
            {
              text: 'Открыть Настройки',
              onPress: () => {
                Linking.openSettings().catch(() => {});
              },
            },
          ]
        );
        return;
      }

      await startNativeOrWebRecording();
      setRecording(true);
      setRecordingSeconds(0);
      timerRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } catch (err: any) {
      Alert.alert(
        'Микрофон',
        err?.message || 'Не удалось активировать микрофон. Разрешите доступ в Настройках устройства.',
        [
          { text: 'Понятно', style: 'cancel' },
          {
            text: 'Настройки iOS',
            onPress: () => Linking.openSettings().catch(() => {}),
          },
        ]
      );
    }
  }

  async function stopVoiceRecording() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setRecording(false);
    setTranscribing(true);

    try {
      const audioResult = await stopNativeOrWebRecording();
      if (!audioResult || !audioResult.audioBase64) {
        Alert.alert('Запись не зафиксирована', 'Не удалось получить аудиозапись. Попробуйте наговорить еще раз.');
        return;
      }
      if (!fieldId) return;

      const res = await summarizeVoiceInspection(fieldId, {
        audioBase64: audioResult.audioBase64,
        mimeType: audioResult.mimeType,
      });

      if (res.summary) {
        setNote((prev) => (prev ? `${prev}\n\n${res.summary}` : res.summary));
      }
    } catch (err) {
      Alert.alert(
        'AI-обработка отчёта',
        err instanceof Error ? err.message : 'Не удалось обработать аудио. Попробуйте еще раз.'
      );
    } finally {
      setTranscribing(false);
    }
  }

  async function aiStructureCurrentNote() {
    if (!fieldId || !note.trim() || transcribing) return;
    setTranscribing(true);
    try {
      const res = await summarizeVoiceInspection(fieldId, { textNotes: note.trim() });
      if (res.summary) {
        setNote(res.summary);
      }
    } catch (err) {
      Alert.alert('AI-структурирование', err instanceof Error ? err.message : 'Не удалось обработать заметку.');
    } finally {
      setTranscribing(false);
    }
  }


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
        setPhotoBase64(result.assets[0].base64 ?? null);
      }
    });
  }, []);

  async function takePhoto() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Доступ ограничен', 'Разрешите доступ к камере в настройках устройства.', [
        { text: 'Отмена', style: 'cancel' },
        { text: 'Открыть Настройки', onPress: () => Linking.openSettings().catch(() => {}) },
      ]);
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.72,
      base64: true,
    });
    if (!result.canceled && result.assets[0]) {
      setPhotoUri(result.assets[0].uri);
      setPhotoBase64(result.assets[0].base64 ?? null);
    }
  }

  async function pickPhoto() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Доступ ограничен', 'Разрешите доступ к фото в настройках устройства.', [
        { text: 'Отмена', style: 'cancel' },
        { text: 'Открыть Настройки', onPress: () => Linking.openSettings().catch(() => {}) },
      ]);
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.72,
      base64: true,
    });
    if (!result.canceled && result.assets[0]) {
      setPhotoUri(result.assets[0].uri);
      setPhotoBase64(result.assets[0].base64 ?? null);
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
      const { inspection, isOffline } = await createInspection({
        fieldId,
        note: note.trim(),
        photoUri,
        photoBase64,
        latitude: coordinates?.latitude ?? null,
        longitude: coordinates?.longitude ?? null,
      });

      if (isOffline) {
        Alert.alert(
          'Сохранено в памяти устройства',
          'Связь с сервером отсутствует или нестабильна. Акт осмотра сохранён локально и будет передан в систему при появлении интернета.',
          [
            {
              text: 'Перейти к участку',
              onPress: () => router.replace({ pathname: '/field/[id]', params: { id: fieldId } }),
            },
          ]
        );
      } else {
        router.replace({ pathname: '/inspection/[id]', params: { id: inspection.id } });
      }
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
            <Pressable
              onPress={() => {
                setPhotoUri(null);
                setPhotoBase64(null);
              }}
              style={styles.removePhotoButton}
            >
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

      {/* Voice / AI Inspection Section */}
      <View style={styles.section}>
        <View style={styles.voiceSectionHeader}>
          <Text style={styles.sectionLabel}>ГОЛОСОВОЙ ОТЧЁТ (AI-АГРОНОМ)</Text>
          {transcribing && (
            <View style={styles.badgeRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.aiBadgeText}>AI анализирует...</Text>
            </View>
          )}
        </View>

        <Card style={styles.voiceCard}>
          {recording ? (
            <View style={styles.recordingBox}>
              <View style={styles.recordingIndicatorRow}>
                <View style={styles.pulsingDot} />
                <Text style={styles.recordingTimerText}>
                  Идёт запись: 00:{recordingSeconds < 10 ? `0${recordingSeconds}` : recordingSeconds}
                </Text>
              </View>
              <Text style={styles.recordingHint}>
                Говорите о фазе культуры, сорняках, влажности или обнаруженных угрозах...
              </Text>
              <Pressable onPress={stopVoiceRecording} style={styles.stopRecordingButton}>
                <Text style={styles.stopRecordingText}>⏹️ Завершить и сформировать акт (AI)</Text>
              </Pressable>
            </View>
          ) : transcribing ? (
            <View style={styles.transcribingBox}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.transcribingText}>
                🤖 AI-агроном расшифровывает аудио и составляет структурированный акт осмотра...
              </Text>
            </View>
          ) : (
            <View style={styles.voiceIdleBox}>
              <Text style={styles.voiceHint}>
                Наговорите голосом обстановку на поле — AI-агроном Tanap AI выделит сорняки, фазу, влажность и заполнит акт:
              </Text>
              <View style={styles.voiceActionsRow}>
                <Pressable onPress={startVoiceRecording} style={styles.voiceRecordButton}>
                  <Text style={styles.voiceRecordButtonText}>🎙️ Наговорить голосом (AI)</Text>
                </Pressable>
                {note.trim().length > 3 && (
                  <Pressable onPress={aiStructureCurrentNote} style={styles.voiceStructureButton}>
                    <Text style={styles.voiceStructureButtonText}>✨ AI-структурировать</Text>
                  </Pressable>
                )}
              </View>
            </View>
          )}
        </Card>
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

  // Voice Inspection Styles
  voiceSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  aiBadgeText: {
    fontFamily: fontFamilies.medium,
    fontSize: 12,
    color: colors.primary,
  },
  voiceCard: {
    padding: 14,
    backgroundColor: '#F0FDF4',
    borderColor: '#BBF7D0',
    borderWidth: 1,
  },
  recordingBox: {
    gap: 10,
    alignItems: 'center',
  },
  recordingIndicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pulsingDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.danger,
  },
  recordingTimerText: {
    fontFamily: fontFamilies.bold,
    fontSize: 15,
    color: colors.danger,
  },
  recordingHint: {
    fontFamily: fontFamilies.regular,
    fontSize: 12,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 16,
  },
  stopRecordingButton: {
    backgroundColor: colors.danger,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  stopRecordingText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 13.5,
    color: '#FFFFFF',
  },
  transcribingBox: {
    paddingVertical: 12,
    alignItems: 'center',
    gap: 8,
  },
  transcribingText: {
    fontFamily: fontFamilies.medium,
    fontSize: 13,
    color: colors.primaryDark,
    textAlign: 'center',
    lineHeight: 18,
  },
  voiceIdleBox: {
    gap: 10,
  },
  voiceHint: {
    fontFamily: fontFamilies.regular,
    fontSize: 12.5,
    color: colors.textSecondary,
    lineHeight: 17,
  },
  voiceActionsRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  voiceRecordButton: {
    flex: 1,
    backgroundColor: colors.primary,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceRecordButtonText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 13,
    color: '#FFFFFF',
  },
  voiceStructureButton: {
    backgroundColor: colors.surface,
    borderColor: colors.primary,
    borderWidth: 1,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceStructureButtonText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 12.5,
    color: colors.primary,
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
