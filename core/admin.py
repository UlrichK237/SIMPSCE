"""
Configuration Admin Django - Smart Maintenance
"""

from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from .models import *


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    list_display = ['username', 'get_full_name', 'role', 'department', 'is_active', 'last_login']
    list_filter = ['role', 'is_active', 'department']
    search_fields = ['username', 'first_name', 'last_name', 'email']
    
    fieldsets = BaseUserAdmin.fieldsets + (
        ('Informations métier', {
            'fields': ('role', 'department', 'phone')
        }),
    )
    
    add_fieldsets = BaseUserAdmin.add_fieldsets + (
        ('Informations métier', {
            'fields': ('role', 'department', 'phone')
        }),
    )


@admin.register(Equipment)
class EquipmentAdmin(admin.ModelAdmin):
    list_display = ['name', 'equipment_type', 'station_number', 'status', 'total_operating_hours']
    list_filter = ['equipment_type', 'status']
    search_fields = ['name', 'station_number']
    
    fieldsets = (
        ('Informations générales', {
            'fields': ('name', 'equipment_type', 'station_number', 'status')
        }),
        ('Seuils Température', {
            'fields': (('temp_threshold', 'temp_critical'),)
        }),
        ('Seuils Pression', {
            'fields': (('pressure_threshold', 'pressure_critical'),)
        }),
        ('Seuils Vibration', {
            'fields': (('vibration_threshold', 'vibration_critical'),)
        }),
        ('Seuils Courant', {
            'fields': (('current_threshold', 'current_critical'),)
        }),
        ('Métadonnées', {
            'fields': ('total_operating_hours', 'last_maintenance_date', 'next_maintenance_date', 'maintenance_frequency_days')
        }),
        ('ESP32', {
            'fields': ('esp32_ip', 'esp32_port')
        }),
    )


@admin.register(Sensor)
class SensorAdmin(admin.ModelAdmin):
    list_display = ['name', 'sensor_type', 'model', 'equipment', 'is_active']
    list_filter = ['sensor_type', 'is_active', 'equipment']
    search_fields = ['name', 'model']


@admin.register(SensorReading)
class SensorReadingAdmin(admin.ModelAdmin):
    list_display = ['sensor', 'value', 'unit', 'timestamp', 'is_anomaly']
    list_filter = ['is_anomaly', 'sensor__sensor_type']
    date_hierarchy = 'timestamp'


@admin.register(Alarm)
class AlarmAdmin(admin.ModelAdmin):
    list_display = ['title', 'equipment', 'severity', 'status', 'created_at']
    list_filter = ['severity', 'status', 'created_at']
    date_hierarchy = 'created_at'


@admin.register(WorkOrder)
class WorkOrderAdmin(admin.ModelAdmin):
    list_display = ['wo_number', 'title', 'equipment', 'wo_type', 'priority', 'status']
    list_filter = ['wo_type', 'priority', 'status']
    search_fields = ['wo_number', 'title']


@admin.register(MaintenancePlan)
class MaintenancePlanAdmin(admin.ModelAdmin):
    list_display = ['title', 'equipment', 'scheduled_date', 'is_completed']
    list_filter = ['is_completed']


@admin.register(SystemSettings)
class SystemSettingsAdmin(admin.ModelAdmin):
    def has_add_permission(self, request):
        # Empêcher la création de multiples instances
        return not SystemSettings.objects.exists()


@admin.register(AuditLog)
class AuditLogAdmin(admin.ModelAdmin):
    list_display = ['user', 'action', 'entity_type', 'timestamp']
    list_filter = ['action', 'timestamp']
    date_hierarchy = 'timestamp'