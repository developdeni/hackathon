import { TextStyle } from 'react-native';

export const fontFamilies = {
  regular: 'Montserrat_400Regular',
  medium: 'Montserrat_500Medium',
  semiBold: 'Montserrat_600SemiBold',
  bold: 'Montserrat_700Bold',
};

export const typography = {
  screenTitle: {
    fontFamily: fontFamilies.bold,
    fontSize: 20,
    lineHeight: 26,
    letterSpacing: -0.3,
  } as TextStyle,
  sectionHeader: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  } as TextStyle,
  headline: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 15,
    lineHeight: 20,
  } as TextStyle,
  body: {
    fontFamily: fontFamilies.regular,
    fontSize: 14,
    lineHeight: 19,
  } as TextStyle,
  bodyMedium: {
    fontFamily: fontFamilies.medium,
    fontSize: 14,
    lineHeight: 19,
  } as TextStyle,
  caption: {
    fontFamily: fontFamilies.regular,
    fontSize: 12,
    lineHeight: 16,
  } as TextStyle,
  captionBold: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 12,
    lineHeight: 16,
  } as TextStyle,
  metaMono: {
    fontFamily: fontFamilies.medium,
    fontSize: 11.5,
    lineHeight: 15,
    letterSpacing: 0.2,
  } as TextStyle,
  button: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 14,
    lineHeight: 18,
  } as TextStyle,
};
