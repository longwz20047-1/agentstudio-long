// frontend/src/components/ProjectUserSelector.tsx
import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, X, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { API_BASE } from '../lib/config';
import { authFetch } from '../lib/authFetch';
import { WeKnoraUser, ProjectUserMapping } from '../types/users';

const PAGE_SIZE = 10;

interface Props {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
  onSave: (mapping: ProjectUserMapping) => void;
}

export const ProjectUserSelector: React.FC<Props> = ({
  projectId,
  isOpen,
  onClose,
  onSave,
}) => {
  const { t } = useTranslation('pages');
  const [users, setUsers] = useState<WeKnoraUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [allowAllUsers, setAllowAllUsers] = useState(true);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [serviceAvailable, setServiceAvailable] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);

  // 过滤用户列表
  const filteredUsers = useMemo(() => {
    if (!searchQuery.trim()) return users;
    const query = searchQuery.toLowerCase();
    return users.filter(
      user =>
        user.username.toLowerCase().includes(query) ||
        user.email.toLowerCase().includes(query)
    );
  }, [users, searchQuery]);

  // 分页
  const totalPages = Math.ceil(filteredUsers.length / PAGE_SIZE);
  const paginatedUsers = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredUsers.slice(start, start + PAGE_SIZE);
  }, [filteredUsers, currentPage]);

  // 搜索变化时重置页码
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery]);

  useEffect(() => {
    if (isOpen) {
      loadData();
    }
  }, [isOpen, projectId]);

  const loadData = async () => {
    setLoading(true);
    try {
      // 检查服务状态
      const statusRes = await authFetch(`${API_BASE}/users/status`);
      if (!statusRes.ok) {
        console.error('Failed to get user service status:', statusRes.status);
        setServiceAvailable(false);
        return;
      }
      const statusData = await statusRes.json();
      setServiceAvailable(statusData.available && statusData.connection?.success);

      // 如果服务不可用，不需要继续加载
      if (!statusData.available || !statusData.connection?.success) {
        return;
      }

      // 加载用户列表
      const usersRes = await authFetch(`${API_BASE}/users`);
      if (usersRes.ok) {
        const usersData = await usersRes.json();
        if (usersData.success) {
          setUsers(usersData.users || []);
        }
      }

      // 加载项目当前配置
      const mappingRes = await authFetch(`${API_BASE}/users/project/${projectId}`);
      if (mappingRes.ok) {
        const mappingData = await mappingRes.json();
        if (mappingData.success && mappingData.mapping) {
          setAllowAllUsers(mappingData.mapping.allowAllUsers);
          setSelectedUserIds(mappingData.mapping.allowedUserIds || []);
        } else {
          setAllowAllUsers(true);
          setSelectedUserIds([]);
        }
      }
    } catch (error) {
      console.error('Failed to load data:', error);
      setServiceAvailable(false);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await authFetch(`${API_BASE}/users/project/${projectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          allowAllUsers,
          allowedUserIds: selectedUserIds,
        }),
      });
      const data = await res.json();
      if (data.success) {
        onSave(data.mapping);
        onClose();
      }
    } catch (error) {
      console.error('Failed to save:', error);
    } finally {
      setSaving(false);
    }
  };

  const toggleUser = (userId: string) => {
    setSelectedUserIds(prev =>
      prev.includes(userId)
        ? prev.filter(id => id !== userId)
        : [...prev, userId]
    );
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="w-5 h-5 text-gray-700 dark:text-gray-300" />
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('projects.userAccess.title', '用户访问控制')}
            </h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-500 dark:text-gray-400">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
            </div>
          ) : !serviceAvailable ? (
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">
              <Users className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>{t('projects.userAccess.serviceUnavailable', '用户服务不可用')}</p>
              <p className="text-sm mt-1">{t('projects.userAccess.checkConfig', '请检查 WeKnora 数据库配置')}</p>
            </div>
          ) : (
            <>
              {/* 全部用户开关 */}
              <label className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg mb-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowAllUsers}
                  onChange={(e) => setAllowAllUsers(e.target.checked)}
                  className="w-4 h-4 text-blue-600"
                />
                <div>
                  <div className="font-medium text-gray-900 dark:text-gray-100">
                    {t('projects.userAccess.allowAll', '允许所有用户访问')}
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    {t('projects.userAccess.allowAllDesc', '不限制用户访问此项目')}
                  </div>
                </div>
              </label>

              {/* 用户列表 */}
              {!allowAllUsers && (
                <div className="space-y-3">
                  {/* 搜索框 */}
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder={t('projects.userAccess.searchPlaceholder', '搜索用户名或邮箱...')}
                      className="w-full pl-9 pr-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>

                  {/* 已选/总数统计 */}
                  <div className="flex items-center justify-between text-sm text-gray-500 dark:text-gray-400">
                    <span>
                      {t('projects.userAccess.selectUsers', '选择允许访问的用户：')}
                    </span>
                    <span>
                      {t('projects.userAccess.selectedCount', '已选 {{selected}} / {{total}} 人', {
                        selected: selectedUserIds.length,
                        total: users.length,
                      })}
                    </span>
                  </div>

                  {/* 用户列表 */}
                  <div className="space-y-2">
                    {paginatedUsers.map(user => (
                      <label
                        key={user.id}
                        className={`flex items-center gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
                          selectedUserIds.includes(user.id)
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 dark:border-blue-400'
                            : 'border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedUserIds.includes(user.id)}
                          onChange={() => toggleUser(user.id)}
                          className="w-4 h-4 text-blue-600"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-gray-900 dark:text-gray-100 truncate">{user.username}</div>
                          <div className="text-sm text-gray-500 dark:text-gray-400 truncate">{user.email}</div>
                        </div>
                        {user.avatar && (
                          <img src={user.avatar} alt="" className="w-8 h-8 rounded-full flex-shrink-0" />
                        )}
                      </label>
                    ))}
                    {filteredUsers.length === 0 && searchQuery && (
                      <div className="text-center py-4 text-gray-500 dark:text-gray-400">
                        {t('projects.userAccess.noSearchResults', '没有找到匹配的用户')}
                      </div>
                    )}
                    {users.length === 0 && !searchQuery && (
                      <div className="text-center py-4 text-gray-500 dark:text-gray-400">
                        {t('projects.userAccess.noUsers', '暂无用户数据')}
                      </div>
                    )}
                  </div>

                  {/* 分页控件 */}
                  {totalPages > 1 && (
                    <div className="flex items-center justify-between pt-2 border-t border-gray-200 dark:border-gray-700">
                      <span className="text-sm text-gray-500 dark:text-gray-400">
                        {t('projects.userAccess.pageInfo', '第 {{current}} / {{total}} 页', {
                          current: currentPage,
                          total: totalPages,
                        })}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                          disabled={currentPage === 1}
                          className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed text-gray-600 dark:text-gray-300"
                        >
                          <ChevronLeft className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                          disabled={currentPage === totalPages}
                          className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed text-gray-600 dark:text-gray-300"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
          >
            {t('projects.userAccess.cancel', '取消')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !serviceAvailable}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? t('projects.userAccess.saving', '保存中...') : t('projects.userAccess.save', '保存')}
          </button>
        </div>
      </div>
    </div>
  );
};
