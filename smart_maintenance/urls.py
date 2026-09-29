"""
URLs principales - Smart Maintenance
"""

from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from rest_framework.routers import DefaultRouter
from rest_framework_simplejwt.views import TokenRefreshView

from core.views import *

# Création du routeur API
router = DefaultRouter()
router.register(r'users', UserViewSet, basename='user')
router.register(r'equipments', EquipmentViewSet, basename='equipment')
router.register(r'sensors', SensorViewSet, basename='sensor')
router.register(r'readings', SensorReadingViewSet, basename='reading')
router.register(r'alarms', AlarmViewSet, basename='alarm')
router.register(r'work-orders', WorkOrderViewSet, basename='workorder')
router.register(r'maintenance-plans', MaintenancePlanViewSet, basename='maintenanceplan')
router.register(r'settings', SystemSettingsViewSet, basename='settings')
router.register(r'audit-logs', AuditLogViewSet, basename='auditlog')

urlpatterns = [
    # Admin Django
    path('admin/', admin.site.urls),
    
    # API REST
    path('api/', include(router.urls)),
    
    # Endpoints spéciaux
    path('api/dashboard/kpis/', dashboard_kpis, name='dashboard-kpis'),
    path('api/esp32/ingest/', esp32_data_ingestion, name='esp32-ingest'),
    
    # JWT
    path('api/token/refresh/', TokenRefreshView.as_view(), name='token_refresh'),
    
    # Frontend (template principal)
    path('', include('core.urls')),
]

# Servir les fichiers statiques et média en développement
if settings.DEBUG:
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)