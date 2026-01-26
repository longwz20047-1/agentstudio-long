import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Bot, FileText, Globe, Zap, Shield, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const LandingPage: React.FC = () => {
  const { t, i18n } = useTranslation('pages');

  const toggleLanguage = () => {
    const newLang = i18n.language === 'zh-CN' ? 'en-US' : 'zh-CN';
    i18n.changeLanguage(newLang);
  };

  useEffect(() => {
    // Update page title dynamically for SEO
    document.title = t('landing.pageTitle');

    // Add or update meta description
    const metaDescription = document.querySelector('meta[name="description"]');
    if (metaDescription) {
      metaDescription.setAttribute('content', t('landing.metaDescription'));
    }
  }, [t]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-gray-900 dark:to-slate-800">
      {/* Navigation */}
      <nav className="bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center space-x-3">
              <img src="/cc-studio.png" alt="AgentStudio" className="w-8 h-8" />
              <span className="text-xl font-semibold text-gray-900 dark:text-white">智能体工作台</span>
            </div>
            <div className="flex items-center space-x-4">
              <button
                onClick={toggleLanguage}
                className="inline-flex items-center text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
                title={i18n.language === 'zh-CN' ? 'Switch to English' : '切换到中文'}
              >
                <Globe className="w-5 h-5 mr-1" />
                <span className="hidden sm:inline">{i18n.language === 'zh-CN' ? 'EN' : '中文'}</span>
              </button>
              <Link
                to="/dashboard"
                className="inline-flex items-center px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg transition-colors duration-200"
              >
                {t('landing.nav.enterWorkspace')}
                <ArrowRight className="ml-2 w-4 h-4" />
              </Link>
            </div>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="pt-20 pb-16 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto text-center">
          <h1 className="text-5xl sm:text-6xl font-bold text-gray-900 dark:text-white mb-6">
            <span className="bg-gradient-to-r from-blue-600 to-purple-600 dark:from-blue-400 dark:to-purple-400 bg-clip-text text-transparent">
              {t('landing.hero.title')}
            </span>
            <br />
            {t('landing.hero.subtitle')}
          </h1>
          <p className="text-xl text-gray-600 dark:text-gray-300 mb-8 max-w-3xl mx-auto leading-relaxed">
            {t('landing.hero.description')}
          </p>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-16 px-4 sm:px-6 lg:px-8 bg-white dark:bg-gray-800/50">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-4">{t('landing.features.title')}</h2>
            <p className="text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
              {t('landing.features.subtitle')}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {/* Feature 1 */}
            <div className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-900/50 dark:to-indigo-900/50 p-8 rounded-2xl border border-blue-100 dark:border-blue-700/50">
              <div className="w-12 h-12 bg-blue-600 rounded-lg flex items-center justify-center mb-6">
                <Globe className="w-6 h-6 text-white" />
              </div>
              <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">{t('landing.features.modernWeb.title')}</h3>
              <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
                {t('landing.features.modernWeb.description')}
              </p>
            </div>

            {/* Feature 2 */}
            <div className="bg-gradient-to-br from-purple-50 to-pink-50 dark:from-purple-900/50 dark:to-pink-900/50 p-8 rounded-2xl border border-purple-100 dark:border-purple-700/50">
              <div className="w-12 h-12 bg-purple-600 rounded-lg flex items-center justify-center mb-6">
                <Bot className="w-6 h-6 text-white" />
              </div>
              <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">{t('landing.features.multiModel.title')}</h3>
              <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
                {t('landing.features.multiModel.description')}
              </p>
            </div>

            {/* Feature 3 */}
            <div className="bg-gradient-to-br from-green-50 to-emerald-50 dark:from-green-900/50 dark:to-emerald-900/50 p-8 rounded-2xl border border-green-100 dark:border-green-700/50">
              <div className="w-12 h-12 bg-green-600 rounded-lg flex items-center justify-center mb-6">
                <Users className="w-6 h-6 text-white" />
              </div>
              <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">{t('landing.features.agentSystem.title')}</h3>
              <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
                {t('landing.features.agentSystem.description')}
              </p>
            </div>

            {/* Feature 4 */}
            <div className="bg-gradient-to-br from-orange-50 to-red-50 dark:from-orange-900/50 dark:to-red-900/50 p-8 rounded-2xl border border-orange-100 dark:border-orange-700/50">
              <div className="w-12 h-12 bg-orange-600 rounded-lg flex items-center justify-center mb-6">
                <FileText className="w-6 h-6 text-white" />
              </div>
              <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">{t('landing.features.fileManagement.title')}</h3>
              <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
                {t('landing.features.fileManagement.description')}
              </p>
            </div>

            {/* Feature 5 */}
            <div className="bg-gradient-to-br from-teal-50 to-cyan-50 dark:from-teal-900/50 dark:to-cyan-900/50 p-8 rounded-2xl border border-teal-100 dark:border-teal-700/50">
              <div className="w-12 h-12 bg-teal-600 rounded-lg flex items-center justify-center mb-6">
                <Zap className="w-6 h-6 text-white" />
              </div>
              <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">{t('landing.features.professionalTools.title')}</h3>
              <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
                {t('landing.features.professionalTools.description')}
              </p>
            </div>

            {/* Feature 6 */}
            <div className="bg-gradient-to-br from-gray-50 to-slate-50 dark:from-gray-800/50 dark:to-slate-800/50 p-8 rounded-2xl border border-gray-100 dark:border-gray-600/50">
              <div className="w-12 h-12 bg-gray-600 rounded-lg flex items-center justify-center mb-6">
                <Shield className="w-6 h-6 text-white" />
              </div>
              <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">{t('landing.features.secureReliable.title')}</h3>
              <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
                {t('landing.features.secureReliable.description')}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-gray-100 dark:bg-gray-900 text-gray-600 dark:text-gray-300 py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
            <div className="col-span-1 md:col-span-2">
              <div className="flex items-center space-x-3 mb-4">
                <img src="/cc-studio.png" alt="AgentStudio" className="w-8 h-8" />
                <span className="text-xl font-bold text-gray-900 dark:text-white">智能体工作台</span>
              </div>
              <p className="text-gray-500 dark:text-gray-400 mb-4 max-w-md">
                {t('landing.footer.description')}
              </p>
            </div>

            <div>
              <h3 className="text-gray-900 dark:text-white font-semibold mb-4">{t('landing.footer.product')}</h3>
              <ul className="space-y-2 text-sm">
              </ul>
            </div>

            <div>
              <h3 className="text-gray-900 dark:text-white font-semibold mb-4">{t('landing.footer.support')}</h3>
              <ul className="space-y-2 text-sm">
              </ul>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;
