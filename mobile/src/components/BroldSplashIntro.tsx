import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Dimensions,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { fontFamilies } from '../theme/typography';

const BROLD_LOGO = require('../../assets/brold_bear_logo.png');
const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

interface BroldSplashIntroProps {
  onFinish: () => void;
}

export function BroldSplashIntro({ onFinish }: BroldSplashIntroProps) {
  // Animation values
  const containerOpacity = useRef(new Animated.Value(1)).current;
  const containerScale = useRef(new Animated.Value(1)).current;

  // Bear logo animations
  const bearScale = useRef(new Animated.Value(0.15)).current;
  const bearOpacity = useRef(new Animated.Value(0)).current;
  const bearRotate = useRef(new Animated.Value(-8)).current;

  // Ambient glow aura
  const glowScale = useRef(new Animated.Value(0.3)).current;
  const glowOpacity = useRef(new Animated.Value(0)).current;

  // Texts
  const titleOpacity = useRef(new Animated.Value(0)).current;
  const titleTranslateY = useRef(new Animated.Value(24)).current;

  const subOpacity = useRef(new Animated.Value(0)).current;
  const subTranslateY = useRef(new Animated.Value(16)).current;

  const isDismissing = useRef(false);

  const handleDismiss = () => {
    if (isDismissing.current) return;
    isDismissing.current = true;

    Animated.parallel([
      Animated.timing(containerOpacity, {
        toValue: 0,
        duration: 400,
        useNativeDriver: true,
      }),
      Animated.timing(containerScale, {
        toValue: 1.06,
        duration: 400,
        useNativeDriver: true,
      }),
    ]).start(() => {
      onFinish();
    });
  };

  useEffect(() => {
    // 1. Initial burst: Bear pop-in with spring physics and glowing aura
    const enterSequence = Animated.sequence([
      // Small pause before explosion
      Animated.delay(100),

      // Bear pops in explosively with spring bounce
      Animated.parallel([
        Animated.timing(bearOpacity, {
          toValue: 1,
          duration: 350,
          useNativeDriver: true,
        }),
        Animated.spring(bearScale, {
          toValue: 1,
          friction: 4.5,
          tension: 85,
          useNativeDriver: true,
        }),
        Animated.spring(bearRotate, {
          toValue: 0,
          friction: 5,
          tension: 70,
          useNativeDriver: true,
        }),
        Animated.timing(glowOpacity, {
          toValue: 0.55,
          duration: 450,
          useNativeDriver: true,
        }),
        Animated.spring(glowScale, {
          toValue: 1.15,
          friction: 5,
          tension: 60,
          useNativeDriver: true,
        }),
      ]),

      // 2. Title "BROLD DEV" slides up smoothly
      Animated.parallel([
        Animated.timing(titleOpacity, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }),
        Animated.timing(titleTranslateY, {
          toValue: 0,
          duration: 400,
          useNativeDriver: true,
        }),
      ]),

      // 3. Subtitle "ceo.Данил Мирошниченко" reveals
      Animated.parallel([
        Animated.timing(subOpacity, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }),
        Animated.timing(subTranslateY, {
          toValue: 0,
          duration: 400,
          useNativeDriver: true,
        }),
      ]),

      // 4. Hold screen for viewer appreciation
      Animated.delay(1300),
    ]);

    enterSequence.start(() => {
      handleDismiss();
    });
  }, []);

  const spin = bearRotate.interpolate({
    inputRange: [-8, 0],
    outputRange: ['-8deg', '0deg'],
  });

  return (
    <Animated.View
      style={[
        styles.overlay,
        {
          opacity: containerOpacity,
          transform: [{ scale: containerScale }],
        },
      ]}
    >
      <Pressable style={styles.pressableContainer} onPress={handleDismiss}>
        {/* Cinematic Ambient Glow Behind Logo */}
        <Animated.View
          style={[
            styles.glowAura,
            {
              opacity: glowOpacity,
              transform: [{ scale: glowScale }],
            },
          ]}
        />

        {/* Roaring Bear Mascot Logo */}
        <Animated.View
          style={[
            styles.bearContainer,
            {
              opacity: bearOpacity,
              transform: [{ scale: bearScale }, { rotate: spin }],
            },
          ]}
        >
          <Image
            source={BROLD_LOGO}
            style={styles.bearImage}
            resizeMode="contain"
          />
        </Animated.View>

        {/* Brand Text: BROLD DEV */}
        <Animated.View
          style={[
            styles.titleWrap,
            {
              opacity: titleOpacity,
              transform: [{ translateY: titleTranslateY }],
            },
          ]}
        >
          <Text style={styles.brandTitle}>
            BROLD <Text style={styles.brandTitleDev}>DEV</Text>
          </Text>
          <View style={styles.brandGlowBar} />
        </Animated.View>

        {/* CEO Subtitle: ceo.Данил Мирошниченко */}
        <Animated.View
          style={[
            styles.subWrap,
            {
              opacity: subOpacity,
              transform: [{ translateY: subTranslateY }],
            },
          ]}
        >
          <View style={styles.badgeContainer}>
            <Text style={styles.ceoPrefix}>ceo.</Text>
            <Text style={styles.ceoName}>Данил Мирошниченко</Text>
          </View>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 999999,
    backgroundColor: '#07080B', // Deep obsidian cyber background
    elevation: 999,
  },
  pressableContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  glowAura: {
    position: 'absolute',
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: '#FF5500',
    top: SCREEN_HEIGHT / 2 - 200,
    shadowColor: '#FF6600',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.85,
    shadowRadius: 50,
  },
  bearContainer: {
    width: 220,
    height: 220,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 26,
    shadowColor: '#FF6200',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.6,
    shadowRadius: 30,
  },
  bearImage: {
    width: 220,
    height: 220,
  },
  titleWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  brandTitle: {
    fontFamily: fontFamilies.bold,
    fontSize: 32,
    letterSpacing: 4.5,
    color: '#FFFFFF',
    textTransform: 'uppercase',
    textAlign: 'center',
    textShadowColor: 'rgba(255, 102, 0, 0.65)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 16,
  },
  brandTitleDev: {
    color: '#FF6A00',
    fontFamily: fontFamilies.bold,
  },
  brandGlowBar: {
    width: 60,
    height: 2.5,
    borderRadius: 2,
    backgroundColor: '#FF6A00',
    marginTop: 8,
    shadowColor: '#FF6A00',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 8,
  },
  subWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  badgeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255, 106, 0, 0.35)',
    gap: 4,
  },
  ceoPrefix: {
    fontFamily: fontFamilies.bold,
    fontSize: 13,
    letterSpacing: 1.2,
    color: '#FF7700',
  },
  ceoName: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 13.5,
    letterSpacing: 0.8,
    color: '#E8ECF2',
  },
});
