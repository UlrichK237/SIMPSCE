"""
Vues API REST - Smart Maintenance
"""

from rest_framework import viewsets, status, permissions
from rest_framework.decorators import api_view, permission_classes, action
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import RefreshToken
from django.contrib.auth import authenticate
from django.utils import timezone
from django.db.models import Count, Q
from django.shortcuts import get_object_or_404
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync
from datetime import timedelta
import json

from .models import *
from .serializers import *
from .permissions import *


# ============================================================
# AUTHENTIFICATION
# ============================================================

class UserViewSet(viewsets.ModelViewSet):
    queryset = User.objects.all()
    serializer_class = UserSerializer
    
    def get_permissions(self):
        if self.action in ['login', 'create']:
            return [permissions.AllowAny()]
        if self.action == 'me':
            return [permissions.IsAuthenticated()]
        return [IsSuperviseur()]
    
    def get_serializer_class(self):
        if self.action == 'create':
            return UserCreateSerializer
        return UserSerializer
    
    @action(detail=False, methods=['post'], permission_classes=[permissions.AllowAny])
    def login(self, request):
        """Authentification JWT"""
        username = request.data.get('username')
        password = request.data.get('password')
        
        if not username or not password:
            return Response(
                {'error': 'Identifiant et mot de passe requis'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        user = authenticate(username=username, password=password)
        
        if user and user.is_active:
            refresh = RefreshToken.for_user(user)
            return Response({
                'refresh': str(refresh),
                'access': str(refresh.access_token),
                'user': UserSerializer(user).data
            })
        
        return Response(
            {'error': 'Identifiants invalides ou compte désactivé'},
            status=status.HTTP_401_UNAUTHORIZED
        )
    
    @action(detail=False, methods=['get'])
    def me(self, request):
        """Récupérer l'utilisateur connecté"""
        return Response(UserSerializer(request.user).data)
    
    @action(detail=False, methods=['post'])
    def logout(self, request):
        """Déconnexion (blacklist du refresh token)"""
        try:
            refresh_token = request.data.get('refresh')
            token = RefreshToken(refresh_token)
            token.blacklist()
            return Response({'status': 'Déconnecté avec succès'})
        except Exception:
            return Response({'status': 'Déconnecté'})


# ============================================================
# EQUIPEMENTS
# ============================================================

class EquipmentViewSet(viewsets.ModelViewSet):
    queryset = Equipment.objects.all()
    serializer_class = EquipmentSerializer
    permission_classes = [permissions.IsAuthenticated]
    
    def get_permissions(self):
        if self.action in ['create', 'destroy']:
            return [IsSuperviseur()]
        return [permissions.IsAuthenticated()]
    
    @action(detail=True, methods=['get'])
    def current_values(self, request, pk=None):
        """Valeurs actuelles de tous les capteurs d'un équipement"""
        equipment = self.get_object()
        sensors = equipment.sensors.filter(is_active=True)
        data = {}
        
        for sensor in sensors:
            latest = sensor.readings.first()
            value = latest.value if latest else None
            timestamp = latest.timestamp if latest else None
            
            # Déterminer le statut
            sensor_status = 'normal'
            threshold = None
            critical = None
            
            if sensor.sensor_type == 'temperature':
                threshold = equipment.temp_threshold
                critical = equipment.temp_critical
            elif sensor.sensor_type == 'pressure':
                threshold = equipment.pressure_threshold
                critical = equipment.pressure_critical
            elif sensor.sensor_type == 'vibration':
                threshold = equipment.vibration_threshold
                critical = equipment.vibration_critical
            elif sensor.sensor_type == 'current':
                threshold = equipment.current_threshold
                critical = equipment.current_critical
            elif sensor.sensor_type == 'speed':
                threshold = equipment.speed_threshold
                critical = equipment.speed_critical
            
            if value is not None and critical is not None:
                if value >= critical:
                    sensor_status = 'critical'
                elif value >= threshold:
                    sensor_status = 'warning'
            
            data[sensor.sensor_type] = {
                'sensor_id': sensor.id,
                'name': sensor.name,
                'value': value,
                'unit': sensor.unit or latest.unit if latest else '',
                'status': sensor_status,
                'threshold': threshold,
                'critical': critical,
                'timestamp': timestamp
            }
        
        return Response(data)
    
    @action(detail=True, methods=['get'])
    def readings_history(self, request, pk=None):
        """Historique des lectures d'un équipement"""
        equipment = self.get_object()
        hours = int(request.query_params.get('hours', 24))
        sensor_type = request.query_params.get('sensor_type', None)
        
        since = timezone.now() - timedelta(hours=hours)
        
        sensors = equipment.sensors.all()
        if sensor_type:
            sensors = sensors.filter(sensor_type=sensor_type)
        
        readings = SensorReading.objects.filter(
            sensor__in=sensors,
            timestamp__gte=since
        ).order_by('timestamp')
        
        serializer = SensorReadingSerializer(readings, many=True)
        return Response(serializer.data)
    
    @action(detail=True, methods=['post'], permission_classes=[IsSuperviseurOrMaintenance])
    def update_thresholds(self, request, pk=None):
        """Mettre à jour les seuils d'un équipement"""
        equipment = self.get_object()
        
        fields = [
            'temp_threshold', 'temp_critical',
            'pressure_threshold', 'pressure_critical',
            'vibration_threshold', 'vibration_critical',
            'current_threshold', 'current_critical',
            'speed_threshold', 'speed_critical',
        ]
        
        for field in fields:
            if field in request.data:
                setattr(equipment, field, request.data[field])
        
        equipment.save()
        return Response(EquipmentSerializer(equipment).data)


# ============================================================
# CAPTEURS
# ============================================================

class SensorViewSet(viewsets.ModelViewSet):
    queryset = Sensor.objects.all()
    serializer_class = SensorSerializer
    permission_classes = [IsSuperviseurOrMaintenance]


# ============================================================
# LECTURES CAPTEURS
# ============================================================

class SensorReadingViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = SensorReading.objects.all()
    serializer_class = SensorReadingSerializer
    permission_classes = [permissions.IsAuthenticated]
    
    def get_queryset(self):
        queryset = SensorReading.objects.all()
        
        sensor_id = self.request.query_params.get('sensor', None)
        equipment_id = self.request.query_params.get('equipment', None)
        hours = self.request.query_params.get('hours', 24)
        anomaly_only = self.request.query_params.get('anomaly_only', 'false')
        
        # Filtre temporel
        try:
            hours = int(hours)
        except ValueError:
            hours = 24
        
        since = timezone.now() - timedelta(hours=hours)
        queryset = queryset.filter(timestamp__gte=since)
        
        # Filtres additionnels
        if sensor_id:
            queryset = queryset.filter(sensor_id=sensor_id)
        if equipment_id:
            queryset = queryset.filter(sensor__equipment_id=equipment_id)
        if anomaly_only.lower() == 'true':
            queryset = queryset.filter(is_anomaly=True)
        
        return queryset.order_by('-timestamp')[:1000]


# ============================================================
# ALARMES
# ============================================================

class AlarmViewSet(viewsets.ModelViewSet):
    queryset = Alarm.objects.all()
    serializer_class = AlarmSerializer
    permission_classes = [permissions.IsAuthenticated]
    
    def get_permissions(self):
        if self.action in ['acknowledge']:
            return [CanAcknowledgeAlarm()]
        if self.action in ['resolve', 'create_work_order']:
            return [IsSuperviseurOrMaintenance()]
        return [permissions.IsAuthenticated()]
    
    def get_queryset(self):
        queryset = Alarm.objects.all()
        
        status_filter = self.request.query_params.get('status', None)
        severity = self.request.query_params.get('severity', None)
        equipment_id = self.request.query_params.get('equipment', None)
        
        if status_filter:
            queryset = queryset.filter(status=status_filter)
        if severity:
            queryset = queryset.filter(severity=severity)
        if equipment_id:
            queryset = queryset.filter(equipment_id=equipment_id)
        
        return queryset
    
    @action(detail=True, methods=['post'])
    def acknowledge(self, request, pk=None):
        """Acquitter une alarme"""
        alarm = self.get_object()
        
        if alarm.status != 'active':
            return Response(
                {'error': 'Seules les alarmes actives peuvent être acquittées'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        alarm.status = 'acknowledged'
        alarm.acknowledged_at = timezone.now()
        alarm.acknowledged_by = request.user
        alarm.save()
        
        # Diffusion WebSocket
        self._broadcast_alarm_update(alarm)
        
        return Response({
            'status': 'Alarme acquittée',
            'alarm': AlarmSerializer(alarm).data
        })
    
    @action(detail=True, methods=['post'])
    def resolve(self, request, pk=None):
        """Résoudre une alarme"""
        alarm = self.get_object()
        
        alarm.status = 'resolved'
        alarm.resolved_at = timezone.now()
        alarm.resolved_by = request.user
        alarm.save()
        
        self._broadcast_alarm_update(alarm)
        
        return Response({
            'status': 'Alarme résolue',
            'alarm': AlarmSerializer(alarm).data
        })
    
    @action(detail=True, methods=['post'])
    def create_work_order(self, request, pk=None):
        """Créer un OT depuis une alarme"""
        alarm = self.get_object()
        
        if alarm.work_order:
            return Response(
                {'error': 'Un OT existe déjà pour cette alarme'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        priority_map = {
            'critical': 'urgent',
            'warning': 'high',
            'info': 'normal'
        }
        
        wo = WorkOrder.objects.create(
            title=f"Intervention: {alarm.title}",
            description=f"Alarme déclenchée: {alarm.description}\n\nValeur: {alarm.triggered_value}",
            equipment=alarm.equipment,
            wo_type='corrective',
            priority=priority_map.get(alarm.severity, 'normal'),
            created_by=request.user
        )
        
        alarm.work_order = wo
        alarm.save()
        
        return Response({
            'status': 'Ordre de travail créé',
            'work_order': WorkOrderSerializer(wo).data
        })
    
    def _broadcast_alarm_update(self, alarm):
        """Diffuser la mise à jour via WebSocket"""
        try:
            channel_layer = get_channel_layer()
            async_to_sync(channel_layer.group_send)(
                'alarms',
                {
                    'type': 'alarm_update',
                    'message': AlarmSerializer(alarm).data
                }
            )
        except Exception:
            pass  # Redis non disponible


# ============================================================
# ORDRES DE TRAVAIL
# ============================================================

class WorkOrderViewSet(viewsets.ModelViewSet):
    queryset = WorkOrder.objects.all()
    serializer_class = WorkOrderSerializer
    permission_classes = [permissions.IsAuthenticated]
    
    def get_permissions(self):
        if self.action == 'create':
            return [CanCreateWorkOrder()]
        if self.action in ['destroy']:
            return [IsSuperviseur()]
        return [permissions.IsAuthenticated()]
    
    def get_queryset(self):
        queryset = WorkOrder.objects.all()
        
        status_filter = self.request.query_params.get('status', None)
        wo_type = self.request.query_params.get('type', None)
        priority = self.request.query_params.get('priority', None)
        assigned_to_me = self.request.query_params.get('assigned_to_me', 'false')
        equipment_id = self.request.query_params.get('equipment', None)
        
        if status_filter:
            queryset = queryset.filter(status=status_filter)
        if wo_type:
            queryset = queryset.filter(wo_type=wo_type)
        if priority:
            queryset = queryset.filter(priority=priority)
        if assigned_to_me.lower() == 'true':
            queryset = queryset.filter(assigned_to=self.request.user)
        if equipment_id:
            queryset = queryset.filter(equipment_id=equipment_id)
        
        return queryset
    
    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)
    
    @action(detail=True, methods=['post'])
    def assign(self, request, pk=None):
        """Assigner un OT à un agent"""
        wo = self.get_object()
        user_id = request.data.get('user_id')
        
        if not user_id:
            return Response(
                {'error': 'user_id requis'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        user = get_object_or_404(User, id=user_id)
        wo.assigned_to = user
        wo.status = 'in_progress'
        wo.started_at = timezone.now()
        wo.save()
        
        return Response(WorkOrderSerializer(wo).data)
    
    @action(detail=True, methods=['post'])
    def complete(self, request, pk=None):
        """Clôturer un OT"""
        wo = self.get_object()
        
        wo.status = 'completed'
        wo.completed_at = timezone.now()
        wo.report = request.data.get('report', wo.report)
        wo.cost = request.data.get('cost', wo.cost)
        
        if wo.started_at and wo.completed_at:
            wo.actual_duration = wo.completed_at - wo.started_at
        
        wo.save()
        
        # Mettre à jour la date de dernière maintenance
        equipment = wo.equipment
        equipment.last_maintenance_date = timezone.now()
        
        # Recalculer la prochaine maintenance
        if equipment.maintenance_frequency_days:
            equipment.next_maintenance_date = timezone.now() + timedelta(
                days=equipment.maintenance_frequency_days
            )
        equipment.save()
        
        return Response(WorkOrderSerializer(wo).data)
    
    @action(detail=True, methods=['post'])
    def start(self, request, pk=None):
        """Démarrer un OT"""
        wo = self.get_object()
        
        if wo.status != 'planned':
            return Response(
                {'error': 'Seuls les OT planifiés peuvent être démarrés'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        wo.status = 'in_progress'
        wo.started_at = timezone.now()
        wo.save()
        
        return Response(WorkOrderSerializer(wo).data)


# ============================================================
# PLANIFICATION MAINTENANCE
# ============================================================

class MaintenancePlanViewSet(viewsets.ModelViewSet):
    queryset = MaintenancePlan.objects.all()
    serializer_class = MaintenancePlanSerializer
    permission_classes = [IsSuperviseurOrMaintenance]


# ============================================================
# PARAMETRES SYSTEME
# ============================================================

class SystemSettingsViewSet(viewsets.ModelViewSet):
    queryset = SystemSettings.objects.all()
    serializer_class = SystemSettingsSerializer
    permission_classes = [IsSuperviseur]
    
    def get_object(self):
        """Toujours retourner le singleton"""
        return SystemSettings.get_settings()


# ============================================================
# JOURNAL D'AUDIT
# ============================================================

class AuditLogViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = AuditLog.objects.all()
    serializer_class = AuditLogSerializer
    permission_classes = [IsSuperviseur]


# ============================================================
# TABLEAU DE BORD (KPIs)
# ============================================================

@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated])
def dashboard_kpis(request):
    """KPIs pour le tableau de bord"""
    
    # Équipements
    equipment_count = Equipment.objects.count()
    active_equipment = Equipment.objects.filter(status='en_marche').count()
    alert_equipment = Equipment.objects.filter(status='alerte').count()
    
    # Alarmes
    active_alarms = Alarm.objects.filter(status='active').count()
    critical_alarms = Alarm.objects.filter(status='active', severity='critical').count()
    warning_alarms = Alarm.objects.filter(status='active', severity='warning').count()
    
    # OTs
    total_wos = WorkOrder.objects.count()
    weekly_wos = WorkOrder.objects.filter(
        created_at__gte=timezone.now() - timedelta(days=7)
    ).count()
    pending_wos = WorkOrder.objects.filter(status__in=['planned', 'in_progress']).count()
    completed_wos = WorkOrder.objects.filter(status='completed').count()
    
    # OEE simulé (à remplacer par calcul réel)
    oee = 94.2
    
    # État par équipement
    equipment_status = {}
    for equip in Equipment.objects.all():
        equipment_status[equip.equipment_type] = {
            'id': equip.id,
            'name': equip.name,
            'status': equip.status,
            'status_display': equip.get_status_display(),
            'progress': round(equip.get_maintenance_progress(), 1),
            'station': equip.station_number
        }
    
    # Alarmes récentes
    recent_alarms = Alarm.objects.filter(
        status='active'
    ).order_by('-created_at')[:5]
    
    # OTs récents
    recent_wos = WorkOrder.objects.all().order_by('-created_at')[:5]
    
    # Déterminer le statut global
    if alert_equipment > 0 or critical_alarms > 0:
        overall_status = 'Dégradé'
        overall_status_color = 'amber'
    else:
        overall_status = 'Opérationnel'
        overall_status_color = 'green'
    
    return Response({
        'overall_status': overall_status,
        'overall_status_color': overall_status_color,
        'active_alarms': active_alarms,
        'critical_alarms': critical_alarms,
        'warning_alarms': warning_alarms,
        'total_work_orders': total_wos,
        'weekly_work_orders': weekly_wos,
        'pending_work_orders': pending_wos,
        'completed_work_orders': completed_wos,
        'oee': oee,
        'equipment_status': equipment_status,
        'recent_alarms': AlarmSerializer(recent_alarms, many=True).data,
        'recent_work_orders': WorkOrderSerializer(recent_wos, many=True).data,
    })


# ============================================================
# ENDPOINT ESP32 (Réception données)
# ============================================================

@api_view(['POST'])
@permission_classes([permissions.AllowAny])  # Sécuriser avec clé API en production
def esp32_data_ingestion(request):
    """
    Endpoint pour recevoir les données de l'ESP32
    
    Format attendu:
    {
        "equipment_id": 1,
        "readings": [
            {"sensor_type": "temperature", "value": 45.2, "unit": "°C"},
            {"sensor_type": "pressure", "value": 4.2, "unit": "bar"}
        ]
    }
    """
    data = request.data
    
    equipment_id = data.get('equipment_id')
    readings = data.get('readings', [])
    
    if not equipment_id or not readings:
        return Response(
            {'error': 'equipment_id et readings requis'},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    try:
        equipment = Equipment.objects.get(id=equipment_id)
    except Equipment.DoesNotExist:
        return Response(
            {'error': f'Équipement {equipment_id} non trouvé'},
            status=status.HTTP_404_NOT_FOUND
        )
    
    created_readings = []
    for reading_data in readings:
        sensor_type = reading_data.get('sensor_type')
        value = reading_data.get('value')
        unit = reading_data.get('unit', '')
        raw_value = reading_data.get('raw_value', value)
        
        if sensor_type is None or value is None:
            continue
        
        # Trouver le capteur
        sensor = Sensor.objects.filter(
            equipment=equipment,
            sensor_type=sensor_type,
            is_active=True
        ).first()
        
        if not sensor:
            continue
        
        # Appliquer la calibration
        calibrated_value = sensor.get_calibrated_value(float(value))
        
        # Créer la lecture
        reading = SensorReading.objects.create(
            sensor=sensor,
            value=calibrated_value,
            raw_value=float(raw_value) if raw_value else None,
            unit=unit or sensor.unit
        )
        created_readings.append(reading)
        
        # Vérifier les seuils et créer des alarmes
        _check_thresholds(equipment, sensor, calibrated_value)
    
    # Diffusion temps réel WebSocket
    if created_readings:
        try:
            channel_layer = get_channel_layer()
            async_to_sync(channel_layer.group_send)(
                f'equipment_{equipment_id}',
                {
                    'type': 'sensor_data',
                    'readings': SensorReadingSerializer(created_readings, many=True).data
                }
            )
            # Diffusion globale dashboard
            async_to_sync(channel_layer.group_send)(
                'dashboard',
                {
                    'type': 'dashboard_update',
                    'equipment_id': equipment_id
                }
            )
        except Exception:
            pass
    
    return Response({
        'status': 'success',
        'readings_count': len(created_readings),
        'equipment': equipment.name
    })


def _check_thresholds(equipment, sensor, value):
    """
    Vérifier les seuils et créer des alarmes si nécessaire
    """
    thresholds = {
        'temperature': (equipment.temp_threshold, equipment.temp_critical),
        'pressure': (equipment.pressure_threshold, equipment.pressure_critical),
        'vibration': (equipment.vibration_threshold, equipment.vibration_critical),
        'current': (equipment.current_threshold, equipment.current_critical),
        'speed': (equipment.speed_threshold, equipment.speed_critical),
    }
    
    if sensor.sensor_type not in thresholds:
        return
    
    threshold, critical = thresholds[sensor.sensor_type]
    
    # Alarme CRITIQUE
    if value >= critical:
        existing = Alarm.objects.filter(
            equipment=equipment,
            sensor=sensor,
            severity='critical',
            status='active'
        ).first()
        
        if not existing:
            alarm = Alarm.objects.create(
                title=f"Sur{sensor.get_sensor_type_display()} {equipment.name}",
                description=f"La {sensor.get_sensor_type_display()} a dépassé le seuil critique ({value:.1f} >= {critical:.1f} {sensor.unit})",
                equipment=equipment,
                sensor=sensor,
                severity='critical',
                triggered_value=value,
                threshold_value=critical
            )
            # Diffuser l'alarme
            try:
                channel_layer = get_channel_layer()
                async_to_sync(channel_layer.group_send)(
                    'alarms',
                    {
                        'type': 'alarm_update',
                        'message': AlarmSerializer(alarm).data
                    }
                )
            except Exception:
                pass
    
    # Alarme WARNING
    elif value >= threshold:
        existing = Alarm.objects.filter(
            equipment=equipment,
            sensor=sensor,
            severity='warning',
            status='active'
        ).first()
        
        if not existing:
            Alarm.objects.create(
                title=f"{sensor.get_sensor_type_display()} Élevée {equipment.name}",
                description=f"La {sensor.get_sensor_type_display()} dépasse le seuil normal ({value:.1f} >= {threshold:.1f} {sensor.unit})",
                equipment=equipment,
                sensor=sensor,
                severity='warning',
                triggered_value=value,
                threshold_value=threshold
            )