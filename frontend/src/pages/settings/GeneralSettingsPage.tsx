import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Moon,
  Sun,
  Monitor,
  Globe,
  Settings,
  Info,
  Package,
  Server,
  MessageSquare,
} from 'lucide-react';
import { useMobileContext } from '../../contexts/MobileContext';
import { useSystemInfo } from '../../hooks/useVersionCheck';

export const GeneralSettingsPage: React.FC = () => {
  const { t, i18n } = useTranslation('pages');
  const { isMobile } = useMobileContext();

  // Theme and language state
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'auto');
  const [language, setLanguage] = useState(i18n.language);

  // Chat panel version state
  const [chatVersion, setChatVersion] = useState(() => localStorage.getItem('agentstudio:chat-version') || 'original');

  // System info
  const { systemInfo } = useSystemInfo();

  // Sync language state with i18n
  useEffect(() => {
    setLanguage(i18n.language);
  }, [i18n.language]);

  // Apply theme changes
  useEffect(() => {
    const applyTheme = () => {
      if (theme === 'dark') {
        document.documentElement.classList.add('dark');
      } else if (theme === 'light') {
        document.documentElement.classList.remove('dark');
      } else {
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        if (mediaQuery.matches) {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }
      }
    };

    applyTheme();
    localStorage.setItem('theme', theme);
    window.dispatchEvent(new Event('themechange'));
  }, [theme]);

  const handleLanguageChange = (newLanguage: string) => {
    setLanguage(newLanguage);
    i18n.changeLanguage(newLanguage);
  };

  const handleChatVersionChange = (newVersion: string) => {
    setChatVersion(newVersion);
    localStorage.setItem('agentstudio:chat-version', newVersion);
  };

  return (
    <div className={`${isMobile ? 'space-y-4' : 'space-y-6'}`}>
      {/* Header */}
      <div>
        <h1 className={`${isMobile ? 'text-xl' : 'text-2xl'} font-bold text-gray-900 dark:text-white mb-2 flex items-center gap-2`}>
          <Settings className="w-6 h-6" />
          {t('settings.general.title')}
        </h1>
        <p className="text-gray-600 dark:text-gray-400">{t('settings.general.description')}</p>
      </div>

      {/* Appearance Settings Card */}
      <div className={`bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 ${isMobile ? 'p-4' : 'p-6'}`}>
        <h2 className={`${isMobile ? 'text-base' : 'text-lg'} font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2`}>
          <Monitor className="w-5 h-5" />
          {t('settings.general.interfaceSettings')}
        </h2>
        <div className={`${isMobile ? 'space-y-4' : 'space-y-6'}`}>
          {/* Theme Selection */}
          <div>
            <label className="block font-medium text-gray-900 dark:text-white mb-2">{t('settings.general.theme.label')}</label>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">{t('settings.general.theme.description')}</p>
            <div className={`${isMobile ? 'grid grid-cols-1 gap-2' : 'grid grid-cols-3 gap-3'}`}>
              {[
                { value: 'auto', label: t('settings.general.theme.auto'), icon: Monitor },
                { value: 'light', label: t('settings.general.theme.light'), icon: Sun },
                { value: 'dark', label: t('settings.general.theme.dark'), icon: Moon }
              ].map((option) => (
                <button
                  key={option.value}
                  onClick={() => setTheme(option.value)}
                  className={`${isMobile ? 'p-3' : 'p-4'} border-2 rounded-lg flex items-center ${isMobile ? 'flex-row space-x-3' : 'flex-col space-y-2'} transition-all ${theme === option.value
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                    : 'border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-500'
                    }`}
                >
                  <option.icon className={`${isMobile ? 'w-5 h-5' : 'w-6 h-6'}`} />
                  <span className="text-sm font-medium">{option.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Language Selection */}
          <div>
            <label className="block font-medium text-gray-900 dark:text-white mb-2 flex items-center space-x-2">
              <Globe className={`${isMobile ? 'w-4 h-4' : 'w-5 h-5'}`} />
              <span>{t('settings.general.language.label')}</span>
            </label>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">{t('settings.general.language.description')}</p>
            <div className={`${isMobile ? 'grid grid-cols-1 gap-2' : 'grid grid-cols-2 gap-3'}`}>
              {[
                { value: 'zh-CN', label: '中文简体', flag: '🇨🇳' },
                { value: 'en-US', label: 'English', flag: '🇺🇸' }
              ].map((option) => (
                <button
                  key={option.value}
                  onClick={() => handleLanguageChange(option.value)}
                  className={`${isMobile ? 'p-3' : 'p-4'} border-2 rounded-lg flex items-center space-x-3 transition-all ${language === option.value
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                    : 'border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-500'
                    }`}
                >
                  <span className={`${isMobile ? 'text-xl' : 'text-2xl'}`}>{option.flag}</span>
                  <span className="text-sm font-medium">{option.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Chat Panel Version Selection */}
          <div>
            <label className="block font-medium text-gray-900 dark:text-white mb-2 flex items-center space-x-2">
              <MessageSquare className={`${isMobile ? 'w-4 h-4' : 'w-5 h-5'}`} />
              <span>{t('settings.general.chatVersion.label', 'Chat Panel Version')}</span>
            </label>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">{t('settings.general.chatVersion.description', 'Choose which chat panel implementation to use')}</p>
            <div className={`${isMobile ? 'grid grid-cols-1 gap-2' : 'grid grid-cols-2 gap-3'}`}>
              {[
                { value: 'original', label: t('settings.general.chatVersion.original', 'Original'), icon: '💬', description: t('settings.general.chatVersion.originalDesc', 'Classic chat interface') },
                { value: 'agui', label: t('settings.general.chatVersion.agui', 'AGUI (Experimental)'), icon: '🚀', description: t('settings.general.chatVersion.aguiDesc', 'TDesign-based with AGUI protocol') }
              ].map((option) => (
                <button
                  key={option.value}
                  onClick={() => handleChatVersionChange(option.value)}
                  className={`${isMobile ? 'p-3' : 'p-4'} border-2 rounded-lg flex items-start space-x-3 transition-all text-left ${chatVersion === option.value
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                    : 'border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-500'
                    }`}
                >
                  <span className={`${isMobile ? 'text-xl' : 'text-2xl'}`}>{option.icon}</span>
                  <div>
                    <span className="text-sm font-medium block">{option.label}</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">{option.description}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* System Info Card */}
      <div className={`bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 ${isMobile ? 'p-4' : 'p-6'}`}>
        <h2 className={`${isMobile ? 'text-base' : 'text-lg'} font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2`}>
          <Info className="w-5 h-5" />
          {t('settings.systemInfo.title')}
        </h2>

        <div className="space-y-4">
          {/* Version Info */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
              <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 mb-1">
                <Package className="w-4 h-4" />
                {t('settings.systemInfo.currentVersion')}
              </div>
              <span className="font-mono text-gray-900 dark:text-white">
                v{systemInfo?.app.version || '-'}
              </span>
            </div>
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
              <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 mb-1">
                <Server className="w-4 h-4" />
                Node.js
              </div>
              <p className="font-mono text-gray-900 dark:text-white">
                {systemInfo?.runtime.nodeVersion || '-'}
              </p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
              <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">
                {t('settings.systemInfo.platform')}
              </div>
              <p className="text-gray-900 dark:text-white capitalize">
                {systemInfo?.runtime.platform || '-'} ({systemInfo?.runtime.arch || '-'})
              </p>
            </div>
          </div>

          {/* SDK Info */}
          {systemInfo?.sdk && (
            <div className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-100 mb-3 flex items-center gap-2">
                <Settings className="w-4 h-4" />
                Agent SDK Configuration
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-blue-700 dark:text-blue-300 mb-1">SDK Engine</div>
                  <div className="font-mono text-sm text-blue-900 dark:text-blue-100 font-medium">
                    {systemInfo.sdk.engine === 'claude-code' && '🤖 Claude Code (Default)'}
                    {systemInfo.sdk.engine === 'claude-internal' && '🔒 Claude Internal'}
                    {systemInfo.sdk.engine === 'code-buddy' && '🤝 Code Buddy (Coming Soon)'}
                    {!['claude-code', 'claude-internal', 'code-buddy'].includes(systemInfo.sdk.engine) && systemInfo.sdk.engine}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-blue-700 dark:text-blue-300 mb-1">SDK Directory</div>
                  <div className="font-mono text-xs text-blue-900 dark:text-blue-100 break-all">
                    {systemInfo.sdk.directory}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
