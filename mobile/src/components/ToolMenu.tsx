import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ToolIcon, type ToolIconName } from './ToolIcon';
import { Text } from './AppText';
import { useI18n } from '../i18n';
import { colors } from '../theme/colors';
import { fontFamilies } from '../theme/typography';

type Tool = ToolIconName;
const tools: { id: Tool; key: string; color: string }[] = [
  { id: 'chat', key: 'chat', color: colors.primary },
  { id: 'photo', key: 'photo', color: '#31835A' },
  { id: 'count', key: 'count', color: '#6F8B3D' },
  { id: 'grain', key: 'grain', color: '#A86F19' },
  { id: 'livestock', key: 'herd', color: '#65733E' },
];

export function ToolMenu({ onSelect }: { onSelect: (tool: Tool) => void }) {
  const { t } = useI18n();
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Tanap AI</Text>
        <Text style={styles.subtitle}>{t('ai.subtitle')}</Text>
      </View>
      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
        {tools.map((tool) => (
          <Pressable key={tool.id} accessibilityRole="button" onPress={() => onSelect(tool.id)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
            <View style={[styles.icon, { backgroundColor: tool.color }]}>
              <ToolIcon name={tool.id} />
            </View>
            <View style={styles.content}>
              <Text style={styles.name}>{t(`ai.${tool.key}.title`)}</Text>
              <Text style={styles.description}>{t(`ai.${tool.key}.sub`)}</Text>
            </View>
            <Text style={styles.chevron} accessibilityElementsHidden>›</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { backgroundColor: colors.surface, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 16, gap: 4 },
  title: { fontFamily: fontFamilies.semiBold, fontSize: 22, color: colors.text },
  subtitle: { fontSize: 14, lineHeight: 20, color: colors.textSecondary },
  list: { paddingTop: 20, paddingBottom: 24 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 88, paddingLeft: 16, paddingRight: 16, backgroundColor: colors.surface },
  pressed: { backgroundColor: colors.surfaceSecondary },
  icon: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  content: { flex: 1, minWidth: 0, minHeight: 88, justifyContent: 'center', paddingVertical: 16, gap: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  name: { fontFamily: fontFamilies.semiBold, fontSize: 17, lineHeight: 22, color: colors.text },
  description: { fontSize: 14, lineHeight: 20, color: colors.textSecondary },
  chevron: { fontSize: 24, color: colors.muted },
});
