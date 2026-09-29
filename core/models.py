"""
Modèles de données - Smart Maintenance
Base de données complète pour la maintenance prédictive
"""

from django.db import models
from django.contrib.auth.models import AbstractUser
from django.utils import timezone
from django.core.validators import MinValueValidator, MaxValueValidator


# ============================================================
# 1. UTILISATEURS (Authentification & Rôles)
# ============================================================

class User(AbstractUser):
    """
    Utilisateur personnalisé avec 3 rôles :
    - superviseur : accès complet
    - maintenance : GMAO, rapports
    - operateur : supervision lecture seule
    """
    ROLE_CHOICES = [
        ('superviseur', 'Superviseur'),
        ('maintenance', 'Agent de maintenance'),
        ('operateur', 'Opérateur'),
    ]
    
    role = models.CharField(
        max_length=20,
        choices=ROLE_CHOICES,
        default='operateur',
        verbose_name='Rôle'
    )
    department = models.CharField(
        max_length=100,
        blank=True,
        verbose_name='Département'
    )
    phone = models.CharField(
        max_length=20,
        blank=True,
        verbose_name='Téléphone'
    )
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        db_table = 'users'
        verbose_name = 'Utilisateur'
        verbose_name_plural = 'Utilisateurs'
    
    def __str__(self):
        return f"{self.get_full_name() or self.username} ({self.get_role_display()})"
    
    def get_initials(self):
        """Retourne les initiales pour l'avatar"""
        if self.first_name and self.last_name:
            return f"{self.first_name[0]}{self.last_name[0]}"
        return self.username[:2].upper()


# ============================================================
# 2. EQUIPEMENTS (Remplisseuse, Compresseur, Convoyeur)
# ============================================================

class Equipment(models.Model):
    """
    Équipements critiques de la chaîne d'embouteillage
    """
    EQUIPMENT_TYPES = [
        ('remplisseuse', 'Remplisseuse'),
        ('compresseur', 'Compresseur d\'air'),
        ('convoyeur', 'Convoyeur'),
    ]
    
    STATUS_CHOICES = [
        ('en_marche', 'En marche'),
        ('arret', 'Arrêt'),
        ('maintenance', 'En maintenance'),
        ('alerte', 'Alerte'),
    ]
    
    # Informations générales
    name = models.CharField(max_length=100, verbose_name='Nom')
    equipment_type = models.CharField(
        max_length=20,
        choices=EQUIPMENT_TYPES,
        verbose_name='Type d\'équipement'
    )
    station_number = models.CharField(
        max_length=10,
        default='#1',
        verbose_name='N° Station'
    )
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='en_marche',
        verbose_name='État'
    )
    
    # === SEUILS CONFIGURABLES ===
    # Température
    temp_threshold = models.FloatField(
        default=60.0,
        verbose_name='Seuil température (°C)'
    )
    temp_critical = models.FloatField(
        default=75.0,
        verbose_name='Température critique (°C)'
    )
    
    # Pression
    pressure_threshold = models.FloatField(
        default=5.5,
        verbose_name='Seuil pression (bar)'
    )
    pressure_critical = models.FloatField(
        default=7.0,
        verbose_name='Pression critique (bar)'
    )
    
    # Vibration
    vibration_threshold = models.FloatField(
        default=4.5,
        verbose_name='Seuil vibration (mm/s)'
    )
    vibration_critical = models.FloatField(
        default=6.0,
        verbose_name='Vibration critique (mm/s)'
    )
    
    # Courant
    current_threshold = models.FloatField(
        default=12.0,
        verbose_name='Seuil courant (A)'
    )
    current_critical = models.FloatField(
        default=15.0,
        verbose_name='Courant critique (A)'
    )
    
    # Vitesse (convoyeur uniquement)
    speed_threshold = models.FloatField(
        default=1.5,
        verbose_name='Seuil vitesse (m/s)'
    )
    speed_critical = models.FloatField(
        default=1.8,
        verbose_name='Vitesse critique (m/s)'
    )
    
    # === MÉTADONNÉES ===
    total_operating_hours = models.FloatField(
        default=0.0,
        verbose_name='Heures de fonctionnement'
    )
    last_maintenance_date = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name='Dernière maintenance'
    )
    next_maintenance_date = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name='Prochaine maintenance'
    )
    maintenance_frequency_days = models.IntegerField(
        default=30,
        verbose_name='Fréquence maintenance (jours)'
    )
    
    # === CONFIGURATION ESP32 ===
    esp32_ip = models.GenericIPAddressField(
        default='192.168.1.100',
        verbose_name='IP ESP32'
    )
    esp32_port = models.IntegerField(
        default=8080,
        verbose_name='Port ESP32'
    )
    
    # Timestamps
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        db_table = 'equipments'
        verbose_name = 'Équipement'
        verbose_name_plural = 'Équipements'
        ordering = ['station_number']
    
    def __str__(self):
        return f"{self.name} - Station {self.station_number}"
    
    def get_maintenance_progress(self):
        """
        Calcule le pourcentage du cycle de maintenance écoulé
        Retourne un float entre 0 et 100
        """
        if not self.last_maintenance_date or not self.next_maintenance_date:
            return 0.0
        
        total = (self.next_maintenance_date - self.last_maintenance_date).total_seconds()
        elapsed = (timezone.now() - self.last_maintenance_date).total_seconds()
        
        if total <= 0:
            return 100.0
        
        progress = (elapsed / total) * 100
        return min(100.0, max(0.0, progress))
    
    def get_status_color(self):
        """Retourne la couleur associée au statut"""
        colors = {
            'en_marche': 'green',
            'arret': 'red',
            'maintenance': 'blue',
            'alerte': 'amber',
        }
        return colors.get(self.status, 'gray')


# ============================================================
# 3. CAPTEURS (DS18B20, MPX5700, SW-420, ACS712, etc.)
# ============================================================

class Sensor(models.Model):
    """
    Capteurs installés sur les équipements
    """
    SENSOR_TYPES = [
        ('temperature', 'Température'),
        ('pressure', 'Pression'),
        ('vibration', 'Vibration'),
        ('current', 'Courant'),
        ('speed', 'Vitesse'),
        ('level', 'Niveau'),
    ]
    
    name = models.CharField(
        max_length=50,
        verbose_name='Nom du capteur'
    )
    sensor_type = models.CharField(
        max_length=20,
        choices=SENSOR_TYPES,
        verbose_name='Type de mesure'
    )
    model = models.CharField(
        max_length=50,
        verbose_name='Modèle',
        help_text='Ex: DS18B20, MPX5700, SW-420, ACS712'
    )
    equipment = models.ForeignKey(
        Equipment,
        on_delete=models.CASCADE,
        related_name='sensors',
        verbose_name='Équipement'
    )
    
    # Configuration matérielle
    pin_esp32 = models.CharField(
        max_length=10,
        blank=True,
        verbose_name='Pin GPIO ESP32'
    )
    unit = models.CharField(
        max_length=10,
        default='',
        verbose_name='Unité',
        help_text='Ex: °C, bar, mm/s, A, m/s'
    )
    
    # Calibration
    calibration_offset = models.FloatField(
        default=0.0,
        verbose_name='Offset de calibration'
    )
    calibration_factor = models.FloatField(
        default=1.0,
        verbose_name='Facteur de calibration'
    )
    
    is_active = models.BooleanField(
        default=True,
        verbose_name='Actif'
    )
    created_at = models.DateTimeField(auto_now_add=True)
    
    class Meta:
        db_table = 'sensors'
        verbose_name = 'Capteur'
        verbose_name_plural = 'Capteurs'
    
    def __str__(self):
        return f"{self.name} ({self.model}) - {self.equipment.name}"
    
    def get_calibrated_value(self, raw_value):
        """Applique la calibration à une valeur brute"""
        return (raw_value * self.calibration_factor) + self.calibration_offset


# ============================================================
# 4. LECTURES CAPTEURS (Données temps réel)
# ============================================================

class SensorReading(models.Model):
    """
    Données temps réel des capteurs
    Table volumineuse - utiliser une stratégie de partitionnement en production
    """
    sensor = models.ForeignKey(
        Sensor,
        on_delete=models.CASCADE,
        related_name='readings',
        verbose_name='Capteur'
    )
    value = models.FloatField(verbose_name='Valeur mesurée')
    raw_value = models.FloatField(
        null=True,
        blank=True,
        verbose_name='Valeur brute'
    )
    unit = models.CharField(max_length=10, verbose_name='Unité')
    timestamp = models.DateTimeField(
        auto_now_add=True,
        verbose_name='Horodatage'
    )
    
    # Analyse
    is_anomaly = models.BooleanField(
        default=False,
        verbose_name='Anomalie détectée'
    )
    anomaly_score = models.FloatField(
        null=True,
        blank=True,
        verbose_name='Score d\'anomalie'
    )
    
    class Meta:
        db_table = 'sensor_readings'
        verbose_name = 'Lecture capteur'
        verbose_name_plural = 'Lectures capteurs'
        ordering = ['-timestamp']
        indexes = [
            models.Index(fields=['sensor', '-timestamp'], name='idx_sensor_time'),
            models.Index(fields=['timestamp'], name='idx_timestamp'),
            models.Index(fields=['is_anomaly'], name='idx_anomaly'),
        ]
    
    def __str__(self):
        return f"{self.sensor.name}: {self.value}{self.unit} @ {self.timestamp.strftime('%H:%M:%S')}"


# ============================================================
# 5. ALARMES (Système d'alertes)
# ============================================================

class Alarm(models.Model):
    """
    Système d'alarmes avec gestion des statuts
    """
    SEVERITY_CHOICES = [
        ('info', 'Information'),
        ('warning', 'Avertissement'),
        ('critical', 'Critique'),
    ]
    
    STATUS_CHOICES = [
        ('active', 'Active'),
        ('acknowledged', 'Acquittée'),
        ('resolved', 'Résolue'),
    ]
    
    # Informations
    title = models.CharField(
        max_length=200,
        verbose_name='Titre'
    )
    description = models.TextField(verbose_name='Description')
    
    # Relations
    equipment = models.ForeignKey(
        Equipment,
        on_delete=models.CASCADE,
        related_name='alarms',
        verbose_name='Équipement'
    )
    sensor = models.ForeignKey(
        Sensor,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='alarms',
        verbose_name='Capteur'
    )
    
    # Classification
    severity = models.CharField(
        max_length=20,
        choices=SEVERITY_CHOICES,
        verbose_name='Gravité'
    )
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='active',
        verbose_name='Statut'
    )
    
    # Valeurs au moment du déclenchement
    triggered_value = models.FloatField(
        null=True,
        blank=True,
        verbose_name='Valeur déclenchante'
    )
    threshold_value = models.FloatField(
        null=True,
        blank=True,
        verbose_name='Seuil franchi'
    )
    
    # Gestion
    created_at = models.DateTimeField(auto_now_add=True)
    acknowledged_at = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name='Date acquittement'
    )
    acknowledged_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='acknowledged_alarms',
        verbose_name='Acquittée par'
    )
    resolved_at = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name='Date résolution'
    )
    resolved_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='resolved_alarms',
        verbose_name='Résolue par'
    )
    
    # Lien vers OT généré automatiquement
    work_order = models.OneToOneField(
        'WorkOrder',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='source_alarm',
        verbose_name='Ordre de travail'
    )
    
    class Meta:
        db_table = 'alarms'
        verbose_name = 'Alarme'
        verbose_name_plural = 'Alarmes'
        ordering = ['-created_at']
    
    def __str__(self):
        return f"[{self.get_severity_display()}] {self.title}"
    
    def get_severity_color(self):
        colors = {
            'info': 'blue',
            'warning': 'amber',
            'critical': 'red',
        }
        return colors.get(self.severity, 'gray')
    
    def get_status_badge(self):
        badges = {
            'active': ('bg-red-100', 'text-red-700', 'Active'),
            'acknowledged': ('bg-amber-100', 'text-amber-700', 'Acquittée'),
            'resolved': ('bg-green-100', 'text-green-700', 'Résolue'),
        }
        return badges.get(self.status, ('bg-gray-100', 'text-gray-700', 'Inconnue'))


# ============================================================
# 6. ORDRES DE TRAVAIL (GMAO)
# ============================================================

class WorkOrder(models.Model):
    """
    Ordres de travail pour la gestion de maintenance
    """
    WO_TYPES = [
        ('preventive', 'Préventive'),
        ('corrective', 'Corrective'),
        ('predictive', 'Prédictive'),
    ]
    
    PRIORITY_CHOICES = [
        ('low', 'Basse'),
        ('normal', 'Normale'),
        ('high', 'Haute'),
        ('urgent', 'Urgente'),
    ]
    
    STATUS_CHOICES = [
        ('planned', 'Planifié'),
        ('in_progress', 'En cours'),
        ('completed', 'Terminé'),
        ('cancelled', 'Annulé'),
    ]
    
    # Identification
    wo_number = models.CharField(
        max_length=20,
        unique=True,
        verbose_name='N° OT'
    )
    title = models.CharField(
        max_length=200,
        verbose_name='Titre'
    )
    description = models.TextField(verbose_name='Description')
    
    # Classification
    equipment = models.ForeignKey(
        Equipment,
        on_delete=models.CASCADE,
        related_name='work_orders',
        verbose_name='Équipement'
    )
    wo_type = models.CharField(
        max_length=20,
        choices=WO_TYPES,
        verbose_name='Type d\'intervention'
    )
    priority = models.CharField(
        max_length=20,
        choices=PRIORITY_CHOICES,
        default='normal',
        verbose_name='Priorité'
    )
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='planned',
        verbose_name='Statut'
    )
    
    # Assignation
    assigned_to = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='assigned_work_orders',
        verbose_name='Assigné à'
    )
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        related_name='created_work_orders',
        verbose_name='Créé par'
    )
    
    # Planification
    planned_date = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name='Date planifiée'
    )
    started_at = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name='Date début'
    )
    completed_at = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name='Date fin'
    )
    estimated_duration = models.DurationField(
        null=True,
        blank=True,
        verbose_name='Durée estimée'
    )
    actual_duration = models.DurationField(
        null=True,
        blank=True,
        verbose_name='Durée réelle'
    )
    
    # Rapport d'intervention
    report = models.TextField(
        blank=True,
        verbose_name='Rapport'
    )
    parts_used = models.JSONField(
        default=dict,
        blank=True,
        verbose_name='Pièces utilisées'
    )
    cost = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=0.0,
        verbose_name='Coût (FCFA)'
    )
    
    # Timestamps
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        db_table = 'work_orders'
        verbose_name = 'Ordre de travail'
        verbose_name_plural = 'Ordres de travail'
        ordering = ['-created_at']
    
    def __str__(self):
        return f"{self.wo_number} - {self.title}"
    
    def save(self, *args, **kwargs):
        """Auto-génération du numéro OT"""
        if not self.wo_number:
            year = timezone.now().year
            last_wo = WorkOrder.objects.filter(
                wo_number__startswith=f"OT-{year}"
            ).order_by('-wo_number').first()
            
            if last_wo:
                last_num = int(last_wo.wo_number.split('-')[-1])
                new_num = last_num + 1
            else:
                new_num = 1
            
            self.wo_number = f"OT-{year}-{new_num:03d}"
        
        super().save(*args, **kwargs)
    
    def get_priority_color(self):
        colors = {
            'low': 'blue',
            'normal': 'green',
            'high': 'amber',
            'urgent': 'red',
        }
        return colors.get(self.priority, 'gray')
    
    def get_status_color(self):
        colors = {
            'planned': 'blue',
            'in_progress': 'amber',
            'completed': 'green',
            'cancelled': 'red',
        }
        return colors.get(self.status, 'gray')


# ============================================================
# 7. PLANIFICATION MAINTENANCE
# ============================================================

class MaintenancePlan(models.Model):
    """
    Planification des maintenances préventives
    """
    equipment = models.ForeignKey(
        Equipment,
        on_delete=models.CASCADE,
        related_name='maintenance_plans',
        verbose_name='Équipement'
    )
    title = models.CharField(
        max_length=200,
        verbose_name='Titre'
    )
    description = models.TextField(verbose_name='Description')
    frequency_days = models.IntegerField(
        default=30,
        verbose_name='Fréquence (jours)'
    )
    scheduled_date = models.DateTimeField(
        verbose_name='Date prévue'
    )
    assigned_to = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        verbose_name='Assigné à'
    )
    is_completed = models.BooleanField(
        default=False,
        verbose_name='Terminé'
    )
    completed_at = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name='Date de réalisation'
    )
    work_order = models.ForeignKey(
        WorkOrder,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        verbose_name='OT associé'
    )
    
    class Meta:
        db_table = 'maintenance_plans'
        verbose_name = 'Plan de maintenance'
        verbose_name_plural = 'Plans de maintenance'
        ordering = ['scheduled_date']
    
    def __str__(self):
        return f"{self.equipment.name} - {self.title}"
    
    def get_days_until(self):
        """Nombre de jours avant la maintenance"""
        delta = self.scheduled_date - timezone.now()
        return delta.days
    
    def is_overdue(self):
        """Vérifie si la maintenance est en retard"""
        return not self.is_completed and self.scheduled_date < timezone.now()


# ============================================================
# 8. PARAMETRES SYSTEME
# ============================================================

class SystemSettings(models.Model):
    """
    Paramètres globaux du système (singleton)
    """
    acquisition_frequency_seconds = models.IntegerField(
        default=5,
        verbose_name='Fréquence acquisition (s)',
        validators=[MinValueValidator(1), MaxValueValidator(300)]
    )
    data_retention_days = models.IntegerField(
        default=90,
        verbose_name='Rétention données (jours)',
        validators=[MinValueValidator(7), MaxValueValidator(365)]
    )
    inactivity_alert_minutes = models.IntegerField(
        default=15,
        verbose_name='Alerte inactivité (min)'
    )
    email_notifications = models.BooleanField(
        default=True,
        verbose_name='Notifications email'
    )
    sms_notifications = models.BooleanField(
        default=True,
        verbose_name='Notifications SMS'
    )
    
    # Réseau ESP32
    esp32_ssid = models.CharField(
        max_length=100,
        default='INDUSTRIE_IOT',
        verbose_name='SSID WiFi'
    )
    esp32_password = models.CharField(
        max_length=100,
        blank=True,
        verbose_name='Mot de passe WiFi'
    )
    
    # Version
    software_version = models.CharField(
        max_length=20,
        default='2.4.0',
        verbose_name='Version logiciel'
    )
    last_update = models.DateTimeField(
        auto_now=True,
        verbose_name='Dernière mise à jour'
    )
    updated_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        verbose_name='Modifié par'
    )
    
    class Meta:
        db_table = 'system_settings'
        verbose_name = 'Paramètre système'
        verbose_name_plural = 'Paramètres système'
    
    def __str__(self):
        return f"Paramètres Système v{self.software_version}"
    
    def save(self, *args, **kwargs):
        """Force un seul enregistrement (singleton)"""
        self.pk = 1
        super().save(*args, **kwargs)
    
    @classmethod
    def get_settings(cls):
        """Récupère ou crée les paramètres"""
        settings, created = cls.objects.get_or_create(pk=1)
        return settings


# ============================================================
# 9. JOURNAL D'AUDIT (Traçabilité)
# ============================================================

class AuditLog(models.Model):
    """
    Journal d'audit pour traçabilité des actions
    """
    user = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        verbose_name='Utilisateur'
    )
    action = models.CharField(
        max_length=100,
        verbose_name='Action'
    )
    entity_type = models.CharField(
        max_length=50,
        verbose_name='Type d\'entité'
    )
    entity_id = models.IntegerField(
        null=True,
        blank=True,
        verbose_name='ID entité'
    )
    details = models.JSONField(
        default=dict,
        verbose_name='Détails'
    )
    ip_address = models.GenericIPAddressField(
        null=True,
        blank=True,
        verbose_name='Adresse IP'
    )
    timestamp = models.DateTimeField(
        auto_now_add=True,
        verbose_name='Date/Heure'
    )
    
    class Meta:
        db_table = 'audit_logs'
        verbose_name = 'Journal d\'audit'
        verbose_name_plural = 'Journaux d\'audit'
        ordering = ['-timestamp']
    
    def __str__(self):
        return f"{self.user} - {self.action} @ {self.timestamp.strftime('%d/%m %H:%M')}"