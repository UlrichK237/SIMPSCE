"""
Permissions personnalisées - Smart Maintenance
Gestion des droits par rôle
"""

from rest_framework import permissions


class IsSuperviseur(permissions.BasePermission):
    """
    Accès réservé aux superviseurs uniquement
    """
    message = "Accès réservé aux superviseurs."
    
    def has_permission(self, request, view):
        return (
            request.user.is_authenticated and 
            request.user.role == 'superviseur'
        )


class IsSuperviseurOrMaintenance(permissions.BasePermission):
    """
    Accès pour superviseurs et agents de maintenance
    """
    message = "Accès réservé aux superviseurs et agents de maintenance."
    
    def has_permission(self, request, view):
        return (
            request.user.is_authenticated and 
            request.user.role in ['superviseur', 'maintenance']
        )


class IsOperateurReadOnly(permissions.BasePermission):
    """
    Opérateur : lecture seule sur la supervision
    Superviseur : accès complet
    Maintenance : accès selon le contexte
    """
    message = "Accès en lecture seule pour les opérateurs."
    
    def has_permission(self, request, view):
        if not request.user.is_authenticated:
            return False
        
        # Superviseur : tout faire
        if request.user.role == 'superviseur':
            return True
        
        # Opérateur : lecture seule (GET, HEAD, OPTIONS)
        if request.user.role == 'operateur':
            return request.method in permissions.SAFE_METHODS
        
        # Maintenance : accès standard
        return request.user.role == 'maintenance'


class CanCreateWorkOrder(permissions.BasePermission):
    """
    Seuls superviseur et maintenance peuvent créer des OT
    """
    def has_permission(self, request, view):
        return (
            request.user.is_authenticated and 
            request.user.role in ['superviseur', 'maintenance']
        )


class CanManageThresholds(permissions.BasePermission):
    """
    Seuls superviseur et maintenance peuvent modifier les seuils
    """
    def has_permission(self, request, view):
        if not request.user.is_authenticated:
            return False
        
        # Lecture : tous les authentifiés
        if request.method in permissions.SAFE_METHODS:
            return True
        
        # Écriture : superviseur et maintenance uniquement
        return request.user.role in ['superviseur', 'maintenance']


class CanAcknowledgeAlarm(permissions.BasePermission):
    """
    Tous les rôles peuvent acquitter, mais seuls superviseur/maintenance peuvent résoudre
    """
    def has_permission(self, request, view):
        if not request.user.is_authenticated:
            return False
        
        # Acquittement : tous
        if request.method == 'POST' and 'acknowledge' in request.path:
            return True
        
        # Résolution : superviseur et maintenance
        return request.user.role in ['superviseur', 'maintenance']