"""
Sérialiseurs REST API - Smart Maintenance
"""

from rest_framework import serializers
from .models import *


# ============================================================
# UTILISATEURS
# ============================================================

class UserSerializer(serializers.ModelSerializer):
    role_display = serializers.CharField(source='get_role_display', read_only=True)
    
    class Meta:
        model = User
        fields = [
            'id', 'username', 'first_name', 'last_name', 'email',
            'role', 'role_display', 'department', 'phone',
            'is_active', 'last_login', 'date_joined'
        ]
        extra_kwargs = {
            'password': {'write_only': True},
            'last_login': {'read_only': True},
            'date_joined': {'read_only': True},
        }


class UserCreateSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, required=True)
    
    class Meta:
        model = User
        fields = ['username', 'password', 'first_name', 'last_name', 'email', 'role', 'department', 'phone']
    
    def create(self, validated_data):
        user = User.objects.create(**validated_data)
        user.set_password(validated_data['password'])
        user.save()
        return user


# ============================================================
# CAPTEURS
# ============================================================

class SensorSerializer(serializers.ModelSerializer):
    sensor_type_display = serializers.CharField(source='get_sensor_type_display', read_only=True)
    equipment_name = serializers.CharField(source='equipment.name', read_only=True)
    
    class Meta:
        model = Sensor
        fields = [
            'id', 'name', 'sensor_type', 'sensor_type_display', 'model',
            'equipment', 'equipment_name', 'pin_esp32', 'unit',
            'calibration_offset', 'calibration_factor',
            'is_active', 'created_at'
        ]


class SensorMinimalSerializer(serializers.ModelSerializer):
    """Version légère pour les lectures"""
    class Meta:
        model = Sensor
        fields = ['id', 'name', 'sensor_type', 'unit']


# ============================================================
# EQUIPEMENTS
# ============================================================

class EquipmentSerializer(serializers.ModelSerializer):
    equipment_type_display = serializers.CharField(source='get_equipment_type_display', read_only=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    maintenance_progress = serializers.SerializerMethodField()
    sensors = SensorSerializer(many=True, read_only=True)
    
    class Meta:
        model = Equipment
        fields = [
            'id', 'name', 'equipment_type', 'equipment_type_display',
            'station_number', 'status', 'status_display',
            # Seuils
            'temp_threshold', 'temp_critical',
            'pressure_threshold', 'pressure_critical',
            'vibration_threshold', 'vibration_critical',
            'current_threshold', 'current_critical',
            'speed_threshold', 'speed_critical',
            # Métadonnées
            'total_operating_hours', 'last_maintenance_date',
            'next_maintenance_date', 'maintenance_frequency_days',
            'maintenance_progress',
            # ESP32
            'esp32_ip', 'esp32_port',
            # Relations
            'sensors',
            'created_at', 'updated_at'
        ]
    
    def get_maintenance_progress(self, obj):
        return round(obj.get_maintenance_progress(), 1)


class EquipmentMinimalSerializer(serializers.ModelSerializer):
    """Version légère pour les listes"""
    class Meta:
        model = Equipment
        fields = ['id', 'name', 'equipment_type', 'station_number', 'status']


# ============================================================
# LECTURES CAPTEURS
# ============================================================

class SensorReadingSerializer(serializers.ModelSerializer):
    sensor = SensorMinimalSerializer(read_only=True)
    sensor_id = serializers.PrimaryKeyRelatedField(
        queryset=Sensor.objects.all(),
        source='sensor',
        write_only=True
    )
    equipment_name = serializers.CharField(source='sensor.equipment.name', read_only=True)
    
    class Meta:
        model = SensorReading
        fields = [
            'id', 'sensor', 'sensor_id', 'value', 'raw_value',
            'unit', 'timestamp', 'is_anomaly', 'anomaly_score',
            'equipment_name'
        ]
        read_only_fields = ['timestamp', 'is_anomaly', 'anomaly_score']


class SensorReadingCreateSerializer(serializers.ModelSerializer):
    """Pour la création via l'ESP32"""
    class Meta:
        model = SensorReading
        fields = ['sensor', 'value', 'raw_value', 'unit']


# ============================================================
# ALARMES
# ============================================================

class AlarmSerializer(serializers.ModelSerializer):
    severity_display = serializers.CharField(source='get_severity_display', read_only=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    equipment = EquipmentMinimalSerializer(read_only=True)
    equipment_id = serializers.PrimaryKeyRelatedField(
        queryset=Equipment.objects.all(),
        source='equipment',
        write_only=True
    )
    sensor = SensorMinimalSerializer(read_only=True)
    sensor_id = serializers.PrimaryKeyRelatedField(
        queryset=Sensor.objects.all(),
        source='sensor',
        write_only=True,
        required=False,
        allow_null=True
    )
    acknowledged_by_name = serializers.CharField(
        source='acknowledged_by.get_full_name',
        read_only=True,
        default=None
    )
    resolved_by_name = serializers.CharField(
        source='resolved_by.get_full_name',
        read_only=True,
        default=None
    )
    work_order_number = serializers.CharField(
        source='work_order.wo_number',
        read_only=True,
        default=None
    )
    
    class Meta:
        model = Alarm
        fields = [
            'id', 'title', 'description',
            'equipment', 'equipment_id',
            'sensor', 'sensor_id',
            'severity', 'severity_display',
            'status', 'status_display',
            'triggered_value', 'threshold_value',
            'created_at', 'acknowledged_at', 'acknowledged_by', 'acknowledged_by_name',
            'resolved_at', 'resolved_by', 'resolved_by_name',
            'work_order', 'work_order_number'
        ]


class AlarmAcknowledgeSerializer(serializers.Serializer):
    """Pour l'acquittement d'alarme"""
    pass


class AlarmCreateWorkOrderSerializer(serializers.Serializer):
    """Pour créer un OT depuis une alarme"""
    pass


# ============================================================
# ORDRES DE TRAVAIL
# ============================================================

class WorkOrderSerializer(serializers.ModelSerializer):
    wo_type_display = serializers.CharField(source='get_wo_type_display', read_only=True)
    priority_display = serializers.CharField(source='get_priority_display', read_only=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    
    equipment = EquipmentMinimalSerializer(read_only=True)
    equipment_id = serializers.PrimaryKeyRelatedField(
        queryset=Equipment.objects.all(),
        source='equipment',
        write_only=True
    )
    
    assigned_to = UserSerializer(read_only=True)
    assigned_to_id = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(),
        source='assigned_to',
        write_only=True,
        required=False,
        allow_null=True
    )
    
    created_by = UserSerializer(read_only=True)
    
    class Meta:
        model = WorkOrder
        fields = [
            'id', 'wo_number', 'title', 'description',
            'equipment', 'equipment_id',
            'wo_type', 'wo_type_display',
            'priority', 'priority_display',
            'status', 'status_display',
            'assigned_to', 'assigned_to_id',
            'created_by',
            'planned_date', 'started_at', 'completed_at',
            'estimated_duration', 'actual_duration',
            'report', 'parts_used', 'cost',
            'created_at', 'updated_at'
        ]


class WorkOrderCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = WorkOrder
        fields = [
            'title', 'description', 'equipment',
            'wo_type', 'priority', 'assigned_to',
            'planned_date', 'estimated_duration'
        ]


class WorkOrderUpdateSerializer(serializers.ModelSerializer):
    class Meta:
        model = WorkOrder
        fields = [
            'title', 'description', 'priority',
            'assigned_to', 'planned_date',
            'status', 'report', 'parts_used', 'cost'
        ]


# ============================================================
# PLANIFICATION MAINTENANCE
# ============================================================

class MaintenancePlanSerializer(serializers.ModelSerializer):
    equipment = EquipmentMinimalSerializer(read_only=True)
    equipment_id = serializers.PrimaryKeyRelatedField(
        queryset=Equipment.objects.all(),
        source='equipment',
        write_only=True
    )
    assigned_to = UserSerializer(read_only=True)
    assigned_to_id = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(),
        source='assigned_to',
        write_only=True,
        required=False,
        allow_null=True
    )
    days_until = serializers.SerializerMethodField()
    is_overdue = serializers.SerializerMethodField()
    
    class Meta:
        model = MaintenancePlan
        fields = [
            'id', 'title', 'description',
            'equipment', 'equipment_id',
            'frequency_days', 'scheduled_date',
            'assigned_to', 'assigned_to_id',
            'is_completed', 'completed_at',
            'days_until', 'is_overdue'
        ]
    
    def get_days_until(self, obj):
        return obj.get_days_until()
    
    def get_is_overdue(self, obj):
        return obj.is_overdue()


# ============================================================
# PARAMETRES SYSTEME
# ============================================================

class SystemSettingsSerializer(serializers.ModelSerializer):
    updated_by_name = serializers.CharField(source='updated_by.get_full_name', read_only=True)
    
    class Meta:
        model = SystemSettings
        fields = [
            'id', 'acquisition_frequency_seconds', 'data_retention_days',
            'inactivity_alert_minutes',
            'email_notifications', 'sms_notifications',
            'esp32_ssid', 'esp32_password',
            'software_version', 'last_update', 'updated_by', 'updated_by_name'
        ]


# ============================================================
# JOURNAL D'AUDIT
# ============================================================

class AuditLogSerializer(serializers.ModelSerializer):
    user_name = serializers.CharField(source='user.get_full_name', read_only=True)
    
    class Meta:
        model = AuditLog
        fields = [
            'id', 'user', 'user_name', 'action', 'entity_type',
            'entity_id', 'details', 'ip_address', 'timestamp'
        ]


# ============================================================
# TABLEAU DE BORD (KPIs)
# ============================================================

class DashboardKPISerializer(serializers.Serializer):
    overall_status = serializers.CharField()
    overall_status_color = serializers.CharField()
    active_alarms = serializers.IntegerField()
    critical_alarms = serializers.IntegerField()
    warning_alarms = serializers.IntegerField()
    total_work_orders = serializers.IntegerField()
    weekly_work_orders = serializers.IntegerField()
    pending_work_orders = serializers.IntegerField()
    completed_work_orders = serializers.IntegerField()
    oee = serializers.FloatField()
    equipment_status = serializers.DictField()
    recent_alarms = AlarmSerializer(many=True)
    recent_work_orders = WorkOrderSerializer(many=True)


class EquipmentCurrentValuesSerializer(serializers.Serializer):
    """Valeurs actuelles d'un équipement"""
    sensor_type = serializers.CharField()
    name = serializers.CharField()
    value = serializers.FloatField(allow_null=True)
    unit = serializers.CharField()
    status = serializers.CharField()  # normal, warning, critical
    threshold = serializers.FloatField()
    critical = serializers.FloatField()
    timestamp = serializers.DateTimeField(allow_null=True)