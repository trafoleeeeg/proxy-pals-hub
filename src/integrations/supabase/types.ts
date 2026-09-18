export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agent_keys: {
        Row: {
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          key_hash: string
          key_prefix: string
          last_used_at: string | null
          name: string
          revoked_at: string | null
          scopes: string[]
          team_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          key_hash: string
          key_prefix: string
          last_used_at?: string | null
          name: string
          revoked_at?: string | null
          scopes?: string[]
          team_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          key_hash?: string
          key_prefix?: string
          last_used_at?: string | null
          name?: string
          revoked_at?: string | null
          scopes?: string[]
          team_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_keys_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          agent_key_id: string | null
          created_at: string
          id: string
          meta: Json
          target_id: string | null
          target_type: string | null
          team_id: string
          user_id: string | null
        }
        Insert: {
          action: string
          agent_key_id?: string | null
          created_at?: string
          id?: string
          meta?: Json
          target_id?: string | null
          target_type?: string | null
          team_id: string
          user_id?: string | null
        }
        Update: {
          action?: string
          agent_key_id?: string | null
          created_at?: string
          id?: string
          meta?: Json
          target_id?: string | null
          target_type?: string | null
          team_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_agent_key_id_fkey"
            columns: ["agent_key_id"]
            isOneToOne: false
            referencedRelation: "agent_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_log_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      browser_profiles: {
        Row: {
          cookies_enc: string | null
          cookies_updated_at: string
          created_at: string
          created_by: string | null
          custom_fields: Json
          fingerprint: Json
          folder: string
          id: string
          name: string
          notes: string
          proxy_id: string | null
          status_id: string | null
          tags: string[]
          team_id: string
          updated_at: string
        }
        Insert: {
          cookies_enc?: string | null
          cookies_updated_at?: string
          created_at?: string
          created_by?: string | null
          custom_fields?: Json
          fingerprint?: Json
          folder?: string
          id?: string
          name: string
          notes?: string
          proxy_id?: string | null
          status_id?: string | null
          tags?: string[]
          team_id: string
          updated_at?: string
        }
        Update: {
          cookies_enc?: string | null
          cookies_updated_at?: string
          created_at?: string
          created_by?: string | null
          custom_fields?: Json
          fingerprint?: Json
          folder?: string
          id?: string
          name?: string
          notes?: string
          proxy_id?: string | null
          status_id?: string | null
          tags?: string[]
          team_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "browser_profiles_proxy_id_fkey"
            columns: ["proxy_id"]
            isOneToOne: false
            referencedRelation: "proxies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "browser_profiles_status_id_fkey"
            columns: ["status_id"]
            isOneToOne: false
            referencedRelation: "profile_statuses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "browser_profiles_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      profile_access: {
        Row: {
          created_at: string
          granted_by: string | null
          id: string
          profile_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          granted_by?: string | null
          id?: string
          profile_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          granted_by?: string | null
          id?: string
          profile_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "profile_access_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "browser_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profile_bookmarks: {
        Row: {
          created_at: string
          id: string
          position: number
          profile_id: string
          title: string
          updated_at: string
          url: string
        }
        Insert: {
          created_at?: string
          id?: string
          position?: number
          profile_id: string
          title?: string
          updated_at?: string
          url: string
        }
        Update: {
          created_at?: string
          id?: string
          position?: number
          profile_id?: string
          title?: string
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "profile_bookmarks_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "browser_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profile_browser_settings: {
        Row: {
          active_proxy_id: string | null
          bookmark_bar_visible: boolean
          bookmarks: Json
          created_at: string
          extensions: Json
          profile_id: string
          proxy_failover: boolean
          revision: number
          updated_at: string
          updated_by: string | null
          zoom_level: number
        }
        Insert: {
          active_proxy_id?: string | null
          bookmark_bar_visible?: boolean
          bookmarks?: Json
          created_at?: string
          extensions?: Json
          profile_id: string
          proxy_failover?: boolean
          revision?: number
          updated_at?: string
          updated_by?: string | null
          zoom_level?: number
        }
        Update: {
          active_proxy_id?: string | null
          bookmark_bar_visible?: boolean
          bookmarks?: Json
          created_at?: string
          extensions?: Json
          profile_id?: string
          proxy_failover?: boolean
          revision?: number
          updated_at?: string
          updated_by?: string | null
          zoom_level?: number
        }
        Relationships: [
          {
            foreignKeyName: "profile_browser_settings_active_proxy_id_fkey"
            columns: ["active_proxy_id"]
            isOneToOne: false
            referencedRelation: "proxies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_browser_settings_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "browser_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profile_field_definitions: {
        Row: {
          created_at: string
          field_type: string
          id: string
          name: string
          position: number
          team_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          field_type?: string
          id?: string
          name: string
          position?: number
          team_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          field_type?: string
          id?: string
          name?: string
          position?: number
          team_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profile_field_definitions_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      profile_locks: {
        Row: {
          acquired_at: string
          device_id: string
          device_label: string | null
          expires_at: string
          heartbeat_at: string
          lock_token: string
          profile_id: string
          user_id: string
        }
        Insert: {
          acquired_at?: string
          device_id?: string
          device_label?: string | null
          expires_at?: string
          heartbeat_at?: string
          lock_token?: string
          profile_id: string
          user_id: string
        }
        Update: {
          acquired_at?: string
          device_id?: string
          device_label?: string | null
          expires_at?: string
          heartbeat_at?: string
          lock_token?: string
          profile_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "profile_locks_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "browser_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profile_statuses: {
        Row: {
          color: string
          created_at: string
          id: string
          name: string
          position: number
          team_id: string
          updated_at: string
        }
        Insert: {
          color?: string
          created_at?: string
          id?: string
          name: string
          position?: number
          team_id: string
          updated_at?: string
        }
        Update: {
          color?: string
          created_at?: string
          id?: string
          name?: string
          position?: number
          team_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profile_statuses_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          email: string | null
          id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
        }
        Relationships: []
      }
      proxies: {
        Row: {
          city: string | null
          country: string | null
          created_at: string
          created_by: string | null
          host: string
          id: string
          label: string
          last_check_error: string | null
          last_check_ip: string | null
          last_check_latency_ms: number | null
          last_check_ok: boolean | null
          last_checked_at: string | null
          password_enc: string | null
          port: number
          protocol: Database["public"]["Enums"]["proxy_protocol"]
          rotation_changed_at: string | null
          rotation_last_error: string | null
          rotation_new_ip: string | null
          rotation_previous_ip: string | null
          rotation_requested_at: string | null
          rotation_status: string
          rotation_url_enc: string | null
          team_id: string
          updated_at: string
          username: string | null
        }
        Insert: {
          city?: string | null
          country?: string | null
          created_at?: string
          created_by?: string | null
          host: string
          id?: string
          label?: string
          last_check_error?: string | null
          last_check_ip?: string | null
          last_check_latency_ms?: number | null
          last_check_ok?: boolean | null
          last_checked_at?: string | null
          password_enc?: string | null
          port: number
          protocol?: Database["public"]["Enums"]["proxy_protocol"]
          rotation_changed_at?: string | null
          rotation_last_error?: string | null
          rotation_new_ip?: string | null
          rotation_previous_ip?: string | null
          rotation_requested_at?: string | null
          rotation_status?: string
          rotation_url_enc?: string | null
          team_id: string
          updated_at?: string
          username?: string | null
        }
        Update: {
          city?: string | null
          country?: string | null
          created_at?: string
          created_by?: string | null
          host?: string
          id?: string
          label?: string
          last_check_error?: string | null
          last_check_ip?: string | null
          last_check_latency_ms?: number | null
          last_check_ok?: boolean | null
          last_checked_at?: string | null
          password_enc?: string | null
          port?: number
          protocol?: Database["public"]["Enums"]["proxy_protocol"]
          rotation_changed_at?: string | null
          rotation_last_error?: string | null
          rotation_new_ip?: string | null
          rotation_previous_ip?: string | null
          rotation_requested_at?: string | null
          rotation_status?: string
          rotation_url_enc?: string | null
          team_id?: string
          updated_at?: string
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "proxies_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      team_invites: {
        Row: {
          accepted_at: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string
          role: Database["public"]["Enums"]["app_role"]
          team_id: string
          token: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_by: string
          role?: Database["public"]["Enums"]["app_role"]
          team_id: string
          token: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          role?: Database["public"]["Enums"]["app_role"]
          team_id?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_invites_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      team_members: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          scope: string
          team_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          scope?: string
          team_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          scope?: string
          team_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_members_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      teams: {
        Row: {
          created_at: string
          id: string
          name: string
          owner_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name?: string
          owner_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          owner_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_team_invite: { Args: { _token: string }; Returns: string }
      acquire_profile_lease: {
        Args: {
          _device_id: string
          _device_label?: string
          _profile_id: string
        }
        Returns: Json
      }
      bulk_mutate_profiles: {
        Args: {
          _changes?: Json
          _operation: string
          _profile_ids: string[]
          _team_id: string
        }
        Returns: number
      }
      ensure_workspace: { Args: never; Returns: string }
      force_profile_unlock: { Args: { _profile_id: string }; Returns: boolean }
      import_profile_cookies: {
        Args: { _cookies_enc: string; _profile_id: string }
        Returns: string
      }
      mutate_profile_lease: {
        Args: {
          _cookies_enc?: string
          _device_id?: string
          _lock_token: string
          _operation: string
          _profile_id: string
        }
        Returns: Json
      }
      remove_team_member: {
        Args: { _team_id: string; _user_id: string }
        Returns: boolean
      }
      save_profile_browser_settings: {
        Args: {
          _active_proxy_id?: string
          _bookmark_bar_visible: boolean
          _bookmarks: Json
          _expected_revision?: number
          _extensions: Json
          _profile_id: string
          _proxy_failover?: boolean
          _zoom_level: number
        }
        Returns: {
          active_proxy_id: string | null
          bookmark_bar_visible: boolean
          bookmarks: Json
          created_at: string
          extensions: Json
          profile_id: string
          proxy_failover: boolean
          revision: number
          updated_at: string
          updated_by: string | null
          zoom_level: number
        }
        SetofOptions: {
          from: "*"
          to: "profile_browser_settings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_member_scope: {
        Args: { _scope: string; _team_id: string; _user_id: string }
        Returns: boolean
      }
      set_profiles_access: {
        Args: {
          _granted: boolean
          _profile_ids: string[]
          _team_id: string
          _user_id: string
        }
        Returns: number
      }
    }
    Enums: {
      app_role: "owner" | "member"
      proxy_protocol: "http" | "https" | "socks5"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["owner", "member"],
      proxy_protocol: ["http", "https", "socks5"],
    },
  },
} as const
